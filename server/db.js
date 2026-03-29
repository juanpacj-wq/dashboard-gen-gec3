import sql from 'mssql'

// Support named instances: DB_HOST=192.168.17.20\instanceName
const rawHost = process.env.DB_HOST || 'localhost'
const hasInstance = rawHost.includes('\\')
const serverName = hasInstance ? rawHost.split('\\')[0] : rawHost
const instanceName = hasInstance ? rawHost.split('\\')[1] : undefined

const poolConfig = {
  server:   serverName,
  database: process.env.DB_NAME || 'dashboard_gen',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    instanceName,
  },
}
// Only set port if no named instance (they are mutually exclusive)
if (!hasInstance) poolConfig.port = parseInt(process.env.DB_PORT, 10) || 1433

const pool = new sql.ConnectionPool(poolConfig)

const poolConnect = pool.connect()

export async function getDB() {
  await poolConnect
  return pool
}

/** Ensure schema and tables exist */
export async function initDB() {
  const db = await getDB()
  await db.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'dashboard')
      EXEC('CREATE SCHEMA dashboard');
  `)
  await db.request().query(`
    IF OBJECT_ID('dashboard.generacion_periodos', 'U') IS NULL
    CREATE TABLE dashboard.generacion_periodos (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      unit_id     VARCHAR(10)   NOT NULL,
      fecha       DATE          NOT NULL,
      hora        TINYINT       NOT NULL,
      energia_mwh FLOAT         NOT NULL,
      created_at  DATETIME2     DEFAULT GETDATE(),
      CONSTRAINT UQ_unit_fecha_hora UNIQUE (unit_id, fecha, hora)
    );
  `)
  await db.request().query(`
    IF OBJECT_ID('dashboard.generacion_acumulado', 'U') IS NULL
    CREATE TABLE dashboard.generacion_acumulado (
      unit_id     VARCHAR(10)   PRIMARY KEY,
      fecha       DATE          NOT NULL,
      hora        TINYINT       NOT NULL,
      energia_mwh FLOAT         NOT NULL DEFAULT 0,
      last_mw     FLOAT         NULL,
      last_time   DATETIME2     NOT NULL,
      updated_at  DATETIME2     DEFAULT GETDATE()
    );
  `)
  console.log('[DB] Schema y tablas verificadas')
}

/** Save a completed period */
export async function savePeriod(unitId, fecha, hora, energiaMwh) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('hora', sql.TinyInt, hora)
    .input('energia', sql.Float, energiaMwh)
    .query(`
      MERGE dashboard.generacion_periodos AS target
      USING (SELECT @unitId AS unit_id, @fecha AS fecha, @hora AS hora) AS source
      ON target.unit_id = source.unit_id AND target.fecha = source.fecha AND target.hora = source.hora
      WHEN MATCHED THEN UPDATE SET energia_mwh = @energia, created_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, hora, energia_mwh) VALUES (@unitId, @fecha, @hora, @energia);
    `)
}

/** Save current accumulation checkpoint */
export async function saveAccumState(unitId, fecha, hora, energiaMwh, lastMW, lastTime) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('hora', sql.TinyInt, hora)
    .input('energia', sql.Float, energiaMwh)
    .input('lastMW', sql.Float, lastMW)
    .input('lastTime', sql.DateTime2, lastTime)
    .query(`
      MERGE dashboard.generacion_acumulado AS target
      USING (SELECT @unitId AS unit_id) AS source
      ON target.unit_id = source.unit_id
      WHEN MATCHED THEN UPDATE SET fecha = @fecha, hora = @hora, energia_mwh = @energia,
                                   last_mw = @lastMW, last_time = @lastTime, updated_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, hora, energia_mwh, last_mw, last_time)
                              VALUES (@unitId, @fecha, @hora, @energia, @lastMW, @lastTime);
    `)
}

/** Load current accumulation state (for server restart recovery) */
export async function loadAccumState() {
  const db = await getDB()
  const result = await db.request().query('SELECT * FROM dashboard.generacion_acumulado')
  return result.recordset
}

/** Get completed periods for today */
export async function getTodayPeriods() {
  const db = await getDB()
  const result = await db.request()
    .query(`SELECT unit_id, hora, energia_mwh FROM dashboard.generacion_periodos WHERE fecha = CAST(GETDATE() AS DATE)`)
  return result.recordset
}
