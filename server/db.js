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
  await db.request().query(`
    IF OBJECT_ID('dashboard.despacho_final', 'U') IS NULL
    CREATE TABLE dashboard.despacho_final (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      unit_id         VARCHAR(10)   NOT NULL,
      fecha           DATE          NOT NULL,
      periodo         TINYINT       NOT NULL,
      valor_mw        FLOAT         NOT NULL,
      source          VARCHAR(20)   NOT NULL DEFAULT 'email',
      email_subject   NVARCHAR(500) NULL,
      email_id        VARCHAR(200)  NULL,
      email_date      DATETIME2     NULL,
      created_at      DATETIME2     DEFAULT GETDATE(),
      updated_at      DATETIME2     DEFAULT GETDATE(),
      created_by      VARCHAR(50)   DEFAULT 'system',
      CONSTRAINT UQ_desp_final UNIQUE (unit_id, fecha, periodo),
      CONSTRAINT CK_source CHECK (source IN ('email', 'xm_fallback')),
      CONSTRAINT CK_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)
  // Despacho programado — un registro por unidad/fecha/periodo, se escribe una sola vez
  await db.request().query(`
    IF OBJECT_ID('dashboard.despacho_programado', 'U') IS NULL
    CREATE TABLE dashboard.despacho_programado (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      unit_id     VARCHAR(10)   NOT NULL,
      fecha       DATE          NOT NULL,
      periodo     TINYINT       NOT NULL,
      valor_mw    FLOAT         NOT NULL,
      created_at  DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT UQ_desp_prog UNIQUE (unit_id, fecha, periodo),
      CONSTRAINT CK_desp_prog_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)

  // Redespacho programado — valor vigente por unidad/fecha/periodo, se actualiza con cada lectura
  await db.request().query(`
    IF OBJECT_ID('dashboard.redespacho_programado', 'U') IS NULL
    CREATE TABLE dashboard.redespacho_programado (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      unit_id     VARCHAR(10)   NOT NULL,
      fecha       DATE          NOT NULL,
      periodo     TINYINT       NOT NULL,
      valor_mw    FLOAT         NOT NULL,
      version     INT           NOT NULL DEFAULT 1,
      created_at  DATETIME2     NOT NULL DEFAULT GETDATE(),
      updated_at  DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT UQ_redesp_prog UNIQUE (unit_id, fecha, periodo),
      CONSTRAINT CK_redesp_prog_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)

  // Redespacho histórico — log de auditoría, un registro por cada cambio detectado
  await db.request().query(`
    IF OBJECT_ID('dashboard.redespacho_historico', 'U') IS NULL
    CREATE TABLE dashboard.redespacho_historico (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      unit_id         VARCHAR(10)   NOT NULL,
      fecha           DATE          NOT NULL,
      periodo         TINYINT       NOT NULL,
      valor_mw_prev   FLOAT         NULL,
      valor_mw_new    FLOAT         NOT NULL,
      version         INT           NOT NULL,
      captured_at     DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT CK_redesp_hist_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)

  // Índice para consultas de auditoría por fecha
  await db.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_redesp_hist_fecha' AND object_id = OBJECT_ID('dashboard.redespacho_historico'))
      CREATE INDEX IX_redesp_hist_fecha ON dashboard.redespacho_historico (fecha, unit_id, periodo);
  `)

  // Proyección actual — estado vivo del cálculo de proyección/desviación por unidad
  await db.request().query(`
    IF OBJECT_ID('dashboard.proyeccion_actual', 'U') IS NULL
    CREATE TABLE dashboard.proyeccion_actual (
      unit_id         VARCHAR(10)   NOT NULL PRIMARY KEY,
      fecha           DATE          NOT NULL,
      periodo         TINYINT       NOT NULL,
      acumulado_mwh   FLOAT         NOT NULL DEFAULT 0,
      current_mw      FLOAT         NULL,
      redespacho_mw   FLOAT         NULL,
      proyeccion_mwh  FLOAT         NOT NULL DEFAULT 0,
      desviacion_pct  FLOAT         NULL,
      fraction        FLOAT         NOT NULL DEFAULT 0,
      updated_at      DATETIME2     DEFAULT GETDATE(),
      CONSTRAINT CK_proy_actual_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)

  // Proyección histórico — auditoría append-only, agregado cada 3 min
  await db.request().query(`
    IF OBJECT_ID('dashboard.proyeccion_historico', 'U') IS NULL
    CREATE TABLE dashboard.proyeccion_historico (
      id               INT IDENTITY(1,1) PRIMARY KEY,
      unit_id          VARCHAR(10)   NOT NULL,
      fecha            DATE          NOT NULL,
      periodo          TINYINT       NOT NULL,
      acumulado_mwh    FLOAT         NOT NULL,
      current_mw       FLOAT         NULL,
      redespacho_mw    FLOAT         NULL,
      proyeccion_mwh   FLOAT         NOT NULL,
      desviacion_pct   FLOAT         NULL,
      fraction         FLOAT         NOT NULL,
      samples          INT           NOT NULL,
      window_start     DATETIME2     NOT NULL,
      window_end       DATETIME2     NOT NULL,
      captured_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT CK_proy_hist_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)

  await db.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_proy_hist_fecha' AND object_id = OBJECT_ID('dashboard.proyeccion_historico'))
      CREATE INDEX IX_proy_hist_fecha ON dashboard.proyeccion_historico (fecha, unit_id, periodo);
  `)

  // Proyección por periodo cerrado — 1 registro por unit/fecha/periodo con proyección de cierre
  await db.request().query(`
    IF OBJECT_ID('dashboard.proyeccion_periodos', 'U') IS NULL
    CREATE TABLE dashboard.proyeccion_periodos (
      id                    INT IDENTITY(1,1) PRIMARY KEY,
      unit_id               VARCHAR(10)   NOT NULL,
      fecha                 DATE          NOT NULL,
      periodo               TINYINT       NOT NULL,
      proyeccion_cierre_mwh FLOAT         NOT NULL,
      generacion_real_mwh   FLOAT         NULL,
      redespacho_mw         FLOAT         NULL,
      desviacion_pct        FLOAT         NULL,
      closed_at             DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT UQ_proy_periodos UNIQUE (unit_id, fecha, periodo),
      CONSTRAINT CK_proy_periodos_periodo CHECK (periodo BETWEEN 1 AND 24)
    );
  `)

  // Desviación por periodo cerrado — histórico (mirror de generacion_periodos)
  await db.request().query(`
    IF OBJECT_ID('dashboard.desviacion_periodos', 'U') IS NULL
    CREATE TABLE dashboard.desviacion_periodos (
      id                 INT IDENTITY(1,1) PRIMARY KEY,
      unit_id            VARCHAR(10)   NOT NULL,
      fecha              DATE          NOT NULL,
      periodo            TINYINT       NOT NULL,
      generacion_mwh     FLOAT         NOT NULL,
      desp_final_mw      FLOAT         NULL,
      desp_final_source  VARCHAR(20)   NULL,
      desviacion_pct     FLOAT         NULL,
      created_at         DATETIME2     DEFAULT GETDATE(),
      CONSTRAINT UQ_desv_periodos UNIQUE (unit_id, fecha, periodo),
      CONSTRAINT CK_desv_periodos_periodo CHECK (periodo BETWEEN 1 AND 24)
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

/** Save or update a despacho final record */
export async function saveDespachoFinal(unitId, fecha, periodo, valorMw, source, emailSubject, emailId, emailDate) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .input('valorMw', sql.Float, valorMw)
    .input('source', sql.VarChar, source)
    .input('emailSubject', sql.NVarChar, emailSubject)
    .input('emailId', sql.VarChar, emailId)
    .input('emailDate', sql.DateTime2, emailDate)
    .query(`
      MERGE dashboard.despacho_final AS target
      USING (SELECT @unitId AS unit_id, @fecha AS fecha, @periodo AS periodo) AS source_tbl
      ON target.unit_id = source_tbl.unit_id AND target.fecha = source_tbl.fecha AND target.periodo = source_tbl.periodo
      WHEN MATCHED AND @source = 'email' THEN
        UPDATE SET valor_mw = @valorMw, source = @source, email_subject = @emailSubject,
                   email_id = @emailId, email_date = @emailDate, updated_at = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (unit_id, fecha, periodo, valor_mw, source, email_subject, email_id, email_date)
        VALUES (@unitId, @fecha, @periodo, @valorMw, @source, @emailSubject, @emailId, @emailDate);
    `)
}

/** Get despacho final records for a given date */
export async function getDespachoFinalByDate(fecha) {
  const db = await getDB()
  const result = await db.request()
    .input('fecha', sql.Date, fecha)
    .query(`SELECT unit_id, periodo, valor_mw, source FROM dashboard.despacho_final WHERE fecha = @fecha`)
  return result.recordset
}

// ── Despacho programado (scraper) ───────────────────────────────────────────

/** Save despacho programado — INSERT only, ignores if already exists */
export async function saveDespachoProgBulk(fecha, unitData) {
  // unitData = { GEC3: [24 values], GEC32: [...], ... }
  const db = await getDB()
  for (const [unitId, values] of Object.entries(unitData)) {
    for (let i = 0; i < values.length; i++) {
      const valor = values[i]
      if (valor == null) continue
      await db.request()
        .input('unitId', sql.VarChar, unitId)
        .input('fecha', sql.Date, fecha)
        .input('periodo', sql.TinyInt, i + 1)
        .input('valorMw', sql.Float, valor)
        .query(`
          IF NOT EXISTS (
            SELECT 1 FROM dashboard.despacho_programado
            WHERE unit_id = @unitId AND fecha = @fecha AND periodo = @periodo
          )
          INSERT INTO dashboard.despacho_programado (unit_id, fecha, periodo, valor_mw)
          VALUES (@unitId, @fecha, @periodo, @valorMw);
        `)
    }
  }
}

/** Load despacho programado for a date → { GEC3: [24], GEC32: [24], ... } */
export async function loadDespachoProg(fecha) {
  const db = await getDB()
  const result = await db.request()
    .input('fecha', sql.Date, fecha)
    .query(`SELECT unit_id, periodo, valor_mw FROM dashboard.despacho_programado WHERE fecha = @fecha`)
  if (result.recordset.length === 0) return null
  const data = {}
  for (const row of result.recordset) {
    if (!data[row.unit_id]) data[row.unit_id] = Array(24).fill(0)
    data[row.unit_id][row.periodo - 1] = row.valor_mw
  }
  return data
}

// ── Redespacho programado (scraper) ─────────────────────────────────────────

/** Save redespacho programado — UPSERT, logs changes to historico */
export async function saveRedespachoProgBulk(fecha, unitData) {
  const db = await getDB()
  for (const [unitId, values] of Object.entries(unitData)) {
    for (let i = 0; i < values.length; i++) {
      const valor = values[i]
      if (valor == null) continue
      const periodo = i + 1

      // Read current value
      const current = await db.request()
        .input('unitId', sql.VarChar, unitId)
        .input('fecha', sql.Date, fecha)
        .input('periodo', sql.TinyInt, periodo)
        .query(`SELECT valor_mw, version FROM dashboard.redespacho_programado WHERE unit_id = @unitId AND fecha = @fecha AND periodo = @periodo`)

      const existing = current.recordset[0]

      if (!existing) {
        // First insert
        await db.request()
          .input('unitId', sql.VarChar, unitId)
          .input('fecha', sql.Date, fecha)
          .input('periodo', sql.TinyInt, periodo)
          .input('valorMw', sql.Float, valor)
          .query(`
            INSERT INTO dashboard.redespacho_programado (unit_id, fecha, periodo, valor_mw)
            VALUES (@unitId, @fecha, @periodo, @valorMw);
          `)
        // Log initial value in historico
        await db.request()
          .input('unitId', sql.VarChar, unitId)
          .input('fecha', sql.Date, fecha)
          .input('periodo', sql.TinyInt, periodo)
          .input('valorMw', sql.Float, valor)
          .input('version', sql.Int, 1)
          .query(`
            INSERT INTO dashboard.redespacho_historico (unit_id, fecha, periodo, valor_mw_prev, valor_mw_new, version)
            VALUES (@unitId, @fecha, @periodo, NULL, @valorMw, @version);
          `)
      } else if (Math.abs(existing.valor_mw - valor) > 0.01) {
        // Value changed — update and log
        const newVersion = existing.version + 1
        await db.request()
          .input('unitId', sql.VarChar, unitId)
          .input('fecha', sql.Date, fecha)
          .input('periodo', sql.TinyInt, periodo)
          .input('valorMw', sql.Float, valor)
          .input('version', sql.Int, newVersion)
          .query(`
            UPDATE dashboard.redespacho_programado
            SET valor_mw = @valorMw, version = @version, updated_at = GETDATE()
            WHERE unit_id = @unitId AND fecha = @fecha AND periodo = @periodo;
          `)
        await db.request()
          .input('unitId', sql.VarChar, unitId)
          .input('fecha', sql.Date, fecha)
          .input('periodo', sql.TinyInt, periodo)
          .input('prevMw', sql.Float, existing.valor_mw)
          .input('valorMw', sql.Float, valor)
          .input('version', sql.Int, newVersion)
          .query(`
            INSERT INTO dashboard.redespacho_historico (unit_id, fecha, periodo, valor_mw_prev, valor_mw_new, version)
            VALUES (@unitId, @fecha, @periodo, @prevMw, @valorMw, @version);
          `)
      }
      // If value unchanged → no-op
    }
  }
}

/** Load redespacho programado for a date → { GEC3: [24], GEC32: [24], ... } */
export async function loadRedespachoProg(fecha) {
  const db = await getDB()
  const result = await db.request()
    .input('fecha', sql.Date, fecha)
    .query(`SELECT unit_id, periodo, valor_mw FROM dashboard.redespacho_programado WHERE fecha = @fecha`)
  if (result.recordset.length === 0) return null
  const data = {}
  for (const row of result.recordset) {
    if (!data[row.unit_id]) data[row.unit_id] = Array(24).fill(0)
    data[row.unit_id][row.periodo - 1] = row.valor_mw
  }
  return data
}

// ── Proyección actual / Desviación periodos ─────────────────────────────────

/**
 * Save (UPSERT) the live projection state for a unit.
 * payload = { fecha, periodo, acumuladoMwh, currentMw, redespachoMw, proyeccionMwh, desviacionPct, fraction }
 */
export async function saveProyeccionActual(unitId, payload) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, payload.fecha)
    .input('periodo', sql.TinyInt, payload.periodo)
    .input('acumulado', sql.Float, payload.acumuladoMwh ?? 0)
    .input('currentMw', sql.Float, payload.currentMw ?? null)
    .input('redespacho', sql.Float, payload.redespachoMw ?? null)
    .input('proyeccion', sql.Float, payload.proyeccionMwh ?? 0)
    .input('desviacion', sql.Float, payload.desviacionPct ?? null)
    .input('fraction', sql.Float, payload.fraction ?? 0)
    .query(`
      MERGE dashboard.proyeccion_actual AS target
      USING (SELECT @unitId AS unit_id) AS source
      ON target.unit_id = source.unit_id
      WHEN MATCHED THEN UPDATE SET fecha = @fecha, periodo = @periodo,
                                   acumulado_mwh = @acumulado, current_mw = @currentMw,
                                   redespacho_mw = @redespacho, proyeccion_mwh = @proyeccion,
                                   desviacion_pct = @desviacion, fraction = @fraction,
                                   updated_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, periodo, acumulado_mwh, current_mw, redespacho_mw, proyeccion_mwh, desviacion_pct, fraction)
                              VALUES (@unitId, @fecha, @periodo, @acumulado, @currentMw, @redespacho, @proyeccion, @desviacion, @fraction);
    `)
}

/** Load all live projection rows (for restart recovery / first paint) */
export async function loadProyeccionActual() {
  const db = await getDB()
  const result = await db.request().query('SELECT * FROM dashboard.proyeccion_actual')
  return result.recordset
}

/**
 * Save (UPSERT) the closing-period deviation for a unit.
 * payload = { generacionMwh, despFinalMw, despFinalSource, desviacionPct }
 */
export async function saveDesviacionPeriodo(unitId, fecha, periodo, payload) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .input('generacion', sql.Float, payload.generacionMwh)
    .input('despFinal', sql.Float, payload.despFinalMw ?? null)
    .input('source', sql.VarChar, payload.despFinalSource ?? null)
    .input('desviacion', sql.Float, payload.desviacionPct ?? null)
    .query(`
      MERGE dashboard.desviacion_periodos AS target
      USING (SELECT @unitId AS unit_id, @fecha AS fecha, @periodo AS periodo) AS source_tbl
      ON target.unit_id = source_tbl.unit_id AND target.fecha = source_tbl.fecha AND target.periodo = source_tbl.periodo
      WHEN MATCHED THEN UPDATE SET generacion_mwh = @generacion, desp_final_mw = @despFinal,
                                   desp_final_source = @source, desviacion_pct = @desviacion,
                                   created_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, periodo, generacion_mwh, desp_final_mw, desp_final_source, desviacion_pct)
                              VALUES (@unitId, @fecha, @periodo, @generacion, @despFinal, @source, @desviacion);
    `)
}

/** Get desviacion records for a date */
export async function getDesviacionPeriodosByDate(fecha) {
  const db = await getDB()
  const result = await db.request()
    .input('fecha', sql.Date, fecha)
    .query(`SELECT unit_id, periodo, generacion_mwh, desp_final_mw, desp_final_source, desviacion_pct
            FROM dashboard.desviacion_periodos WHERE fecha = @fecha`)
  return result.recordset
}

/** Shortcut: desviacion records for today */
export async function getTodayDesviacionPeriodos() {
  const db = await getDB()
  const result = await db.request()
    .query(`SELECT unit_id, periodo, generacion_mwh, desp_final_mw, desp_final_source, desviacion_pct
            FROM dashboard.desviacion_periodos WHERE fecha = CAST(GETDATE() AS DATE)`)
  return result.recordset
}

// ── Proyección histórico / Proyección periodos ─────────────────────────────

/**
 * Append one aggregated projection row. Called every 3 minutes from the
 * projection buffer flush in server.js.
 * payload = { fecha, periodo, acumuladoMwh, currentMw, redespachoMw, proyeccionMwh,
 *             desviacionPct, fraction, samples, windowStart, windowEnd }
 */
export async function saveProyeccionHistorico(unitId, payload) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, payload.fecha)
    .input('periodo', sql.TinyInt, payload.periodo)
    .input('acumulado', sql.Float, payload.acumuladoMwh ?? 0)
    .input('currentMw', sql.Float, payload.currentMw ?? null)
    .input('redespacho', sql.Float, payload.redespachoMw ?? null)
    .input('proyeccion', sql.Float, payload.proyeccionMwh ?? 0)
    .input('desviacion', sql.Float, payload.desviacionPct ?? null)
    .input('fraction', sql.Float, payload.fraction ?? 0)
    .input('samples', sql.Int, payload.samples ?? 0)
    .input('windowStart', sql.DateTime2, payload.windowStart)
    .input('windowEnd', sql.DateTime2, payload.windowEnd)
    .query(`
      INSERT INTO dashboard.proyeccion_historico
        (unit_id, fecha, periodo, acumulado_mwh, current_mw, redespacho_mw,
         proyeccion_mwh, desviacion_pct, fraction, samples, window_start, window_end)
      VALUES
        (@unitId, @fecha, @periodo, @acumulado, @currentMw, @redespacho,
         @proyeccion, @desviacion, @fraction, @samples, @windowStart, @windowEnd);
    `)
}

/**
 * UPSERT the closing projection for a completed period.
 * payload = { proyeccionCierreMwh, generacionRealMwh, redespachoMw, desviacionPct }
 */
export async function saveProyeccionPeriodo(unitId, fecha, periodo, payload) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .input('proyCierre', sql.Float, payload.proyeccionCierreMwh ?? 0)
    .input('genReal', sql.Float, payload.generacionRealMwh ?? null)
    .input('redespacho', sql.Float, payload.redespachoMw ?? null)
    .input('desviacion', sql.Float, payload.desviacionPct ?? null)
    .query(`
      MERGE dashboard.proyeccion_periodos AS target
      USING (SELECT @unitId AS unit_id, @fecha AS fecha, @periodo AS periodo) AS source_tbl
      ON target.unit_id = source_tbl.unit_id AND target.fecha = source_tbl.fecha AND target.periodo = source_tbl.periodo
      WHEN MATCHED THEN UPDATE SET proyeccion_cierre_mwh = @proyCierre,
                                   generacion_real_mwh = @genReal,
                                   redespacho_mw = @redespacho,
                                   desviacion_pct = @desviacion,
                                   closed_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, periodo, proyeccion_cierre_mwh, generacion_real_mwh, redespacho_mw, desviacion_pct)
                              VALUES (@unitId, @fecha, @periodo, @proyCierre, @genReal, @redespacho, @desviacion);
    `)
}

/** Get proyeccion_periodos records for a date */
export async function getProyeccionPeriodosByDate(fecha) {
  const db = await getDB()
  const result = await db.request()
    .input('fecha', sql.Date, fecha)
    .query(`SELECT unit_id, periodo, proyeccion_cierre_mwh, generacion_real_mwh, redespacho_mw, desviacion_pct
            FROM dashboard.proyeccion_periodos WHERE fecha = @fecha`)
  return result.recordset
}

/** Shortcut: proyeccion_periodos records for today */
export async function getTodayProyeccionPeriodos() {
  const db = await getDB()
  const result = await db.request()
    .query(`SELECT unit_id, periodo, proyeccion_cierre_mwh, generacion_real_mwh, redespacho_mw, desviacion_pct
            FROM dashboard.proyeccion_periodos WHERE fecha = CAST(GETDATE() AS DATE)`)
  return result.recordset
}

/** Check if a despacho final record exists for a unit/date/period */
export async function existsDespachoFinal(unitId, fecha, periodo) {
  const db = await getDB()
  const result = await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('periodo', sql.TinyInt, periodo)
    .query(`SELECT 1 AS found FROM dashboard.despacho_final WHERE unit_id = @unitId AND fecha = @fecha AND periodo = @periodo`)
  return result.recordset.length > 0
}
