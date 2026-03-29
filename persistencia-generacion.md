# Persistencia de datos de generación

## Problema

La acumulación de energía (integración trapezoidal del PME) y los valores de periodos completados se calculan y almacenan en el **estado React del cliente** (`useRealtimeData.js`). Al refrescar la página o abrir otra pestaña, todo se pierde y vuelve a 0.

## Solución: mover la acumulación al servidor + persistir en MSSQL

### Arquitectura propuesta

```
PME (scraper) → server.js (acumula + guarda en DB) → WebSocket → cliente (solo renderiza)
```

En lugar de que el cliente haga la integración trapezoidal, el **servidor** la hace y guarda los resultados en MSSQL. El cliente solo recibe y muestra.

---

## 1. Base de datos MSSQL

### Tabla: `generacion_periodos`

Almacena el valor de energía acumulada de cada periodo completado.

```sql
CREATE TABLE generacion_periodos (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    unit_id     VARCHAR(10)   NOT NULL,  -- 'GEC3', 'GEC32', 'TGJ1', 'TGJ2'
    fecha       DATE          NOT NULL,  -- fecha del periodo
    hora        TINYINT       NOT NULL,  -- 0-23
    energia_mwh FLOAT         NOT NULL,  -- MWh acumulados en ese periodo
    created_at  DATETIME2     DEFAULT GETDATE(),

    CONSTRAINT UQ_unit_fecha_hora UNIQUE (unit_id, fecha, hora)
);
```

### Tabla: `generacion_acumulado` (estado actual del periodo en curso)

Permite recuperar el estado si el servidor se reinicia a mitad de un periodo.

```sql
CREATE TABLE generacion_acumulado (
    unit_id     VARCHAR(10)   PRIMARY KEY,
    fecha       DATE          NOT NULL,
    hora        TINYINT       NOT NULL,
    energia_mwh FLOAT         NOT NULL DEFAULT 0,
    last_mw     FLOAT         NULL,      -- último valor MW para continuar integración
    last_time   DATETIME2     NOT NULL,   -- timestamp del último valor
    updated_at  DATETIME2     DEFAULT GETDATE()
);
```

---

## 2. Cambios en el servidor (`server/`)

### 2.1 Nueva dependencia: driver MSSQL

```bash
cd server
npm install mssql
```

### 2.2 Nuevo archivo: `server/db.js`

Conexión y queries a MSSQL.

```js
import sql from 'mssql'

const pool = new sql.ConnectionPool({
  server:   process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'dashboard_gen',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,              // true si usa SSL
    trustServerCertificate: true
  }
})

const poolConnect = pool.connect()

export async function getDB() {
  await poolConnect
  return pool
}

// Guardar periodo completado
export async function savePeriod(unitId, fecha, hora, energiaMwh) {
  const db = await getDB()
  await db.request()
    .input('unitId', sql.VarChar, unitId)
    .input('fecha', sql.Date, fecha)
    .input('hora', sql.TinyInt, hora)
    .input('energia', sql.Float, energiaMwh)
    .query(`
      MERGE generacion_periodos AS target
      USING (SELECT @unitId AS unit_id, @fecha AS fecha, @hora AS hora) AS source
      ON target.unit_id = source.unit_id AND target.fecha = source.fecha AND target.hora = source.hora
      WHEN MATCHED THEN UPDATE SET energia_mwh = @energia, created_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, hora, energia_mwh) VALUES (@unitId, @fecha, @hora, @energia);
    `)
}

// Guardar estado actual del acumulado (cada ~30s para no perder progreso)
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
      MERGE generacion_acumulado AS target
      USING (SELECT @unitId AS unit_id) AS source
      ON target.unit_id = source.unit_id
      WHEN MATCHED THEN UPDATE SET fecha = @fecha, hora = @hora, energia_mwh = @energia,
                                   last_mw = @lastMW, last_time = @lastTime, updated_at = GETDATE()
      WHEN NOT MATCHED THEN INSERT (unit_id, fecha, hora, energia_mwh, last_mw, last_time)
                              VALUES (@unitId, @fecha, @hora, @energia, @lastMW, @lastTime);
    `)
}

// Recuperar estado acumulado (al iniciar el servidor)
export async function loadAccumState() {
  const db = await getDB()
  const result = await db.request().query('SELECT * FROM generacion_acumulado')
  return result.recordset
}

// Obtener periodos completados de hoy
export async function getTodayPeriods() {
  const db = await getDB()
  const result = await db.request()
    .query(`SELECT unit_id, hora, energia_mwh FROM generacion_periodos WHERE fecha = CAST(GETDATE() AS DATE)`)
  return result.recordset
}
```

### 2.3 Nuevo archivo: `server/accumulator.js`

Integración trapezoidal en el servidor (mover la lógica de `useRealtimeData.js`).

```js
import { savePeriod, saveAccumState, loadAccumState } from './db.js'

export class EnergyAccumulator {
  #state = {}       // { unitId: { mwh, lastMW, lastTime, hour, date } }
  #completed = {}   // { unitId: { [hourIdx]: mwhValue } }
  #saveInterval = null

  async init() {
    // Recuperar estado de la DB al iniciar
    const rows = await loadAccumState()
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const currentHour = now.getHours()

    for (const row of rows) {
      const rowDate = new Date(row.fecha).toISOString().slice(0, 10)
      // Solo restaurar si es del periodo actual (misma fecha y hora)
      if (rowDate === todayStr && row.hora === currentHour) {
        this.#state[row.unit_id] = {
          mwh: row.energia_mwh,
          lastMW: row.last_mw,
          lastTime: new Date(row.last_time),
          hour: row.hora,
          date: rowDate,
        }
      }
    }
    console.log('[Accumulator] Estado restaurado:', Object.keys(this.#state).length, 'unidades')

    // Guardar estado en DB cada 30 segundos
    this.#saveInterval = setInterval(() => this.#persistState(), 30_000)
  }

  // Llamado cada vez que llega un update del scraper
  update(units) {
    const now = new Date()
    const currentHour = now.getHours()
    const todayStr = now.toISOString().slice(0, 10)

    for (const unit of units) {
      if (unit.valueMW === null) continue

      const prev = this.#state[unit.id]

      // Detectar cambio de hora → guardar periodo completado
      if (prev && (prev.hour !== currentHour || prev.date !== todayStr)) {
        this.#completePeriod(unit.id, prev.date, prev.hour, prev.mwh)
        // Reset para nuevo periodo
        this.#state[unit.id] = { mwh: 0, lastMW: unit.valueMW, lastTime: now, hour: currentHour, date: todayStr }
        continue
      }

      if (!prev) {
        this.#state[unit.id] = { mwh: 0, lastMW: unit.valueMW, lastTime: now, hour: currentHour, date: todayStr }
        continue
      }

      // Integración trapezoidal: area = (MW1 + MW2) / 2 * deltaHoras
      const deltaMs = now - prev.lastTime
      const deltaHours = deltaMs / 3_600_000
      const avgMW = (prev.lastMW + unit.valueMW) / 2
      prev.mwh += avgMW * deltaHours
      prev.lastMW = unit.valueMW
      prev.lastTime = now
    }
  }

  // Obtener datos para enviar al cliente
  getState() {
    const accumulated = {}
    for (const [id, s] of Object.entries(this.#state)) {
      accumulated[id] = s.mwh
    }
    return { accumulated, completedPeriods: this.#completed }
  }

  async #completePeriod(unitId, date, hour, mwh) {
    if (!this.#completed[unitId]) this.#completed[unitId] = {}
    this.#completed[unitId][hour] = mwh

    try {
      await savePeriod(unitId, date, hour, mwh)
      console.log(`[Accumulator] Periodo guardado: ${unitId} hora=${hour} energia=${mwh.toFixed(3)} MWh`)
    } catch (err) {
      console.error(`[Accumulator] Error guardando periodo:`, err.message)
    }
  }

  async #persistState() {
    for (const [unitId, s] of Object.entries(this.#state)) {
      try {
        await saveAccumState(unitId, s.date, s.hour, s.mwh, s.lastMW, s.lastTime)
      } catch (err) {
        console.error(`[Accumulator] Error persistiendo estado:`, err.message)
      }
    }
  }

  async stop() {
    clearInterval(this.#saveInterval)
    await this.#persistState()
  }
}
```

### 2.4 Modificar `server/server.js`

```js
// Agregar imports
import { EnergyAccumulator } from './accumulator.js'
import { getTodayPeriods } from './db.js'

// Crear acumulador
const accumulator = new EnergyAccumulator()
await accumulator.init()

// En el callback del scraper (onData), agregar:
// accumulator.update(msg.units)

// En el broadcast a clientes, agregar datos de acumulación:
// const { accumulated, completedPeriods } = accumulator.getState()
// msg.accumulated = accumulated
// msg.completedPeriods = completedPeriods

// Endpoint REST para cargar periodos completados al abrir la página:
// GET /api/periods/today → devuelve periodos de hoy desde MSSQL

// En el handler HTTP existente, agregar:
if (req.url === '/api/periods/today' && req.method === 'GET') {
  const periods = await getTodayPeriods()
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(periods))
  return
}
```

### 2.5 Nuevo endpoint en nginx (`deploy/nginx.conf`)

```nginx
location /api/periods/ {
    proxy_pass http://127.0.0.1:3001;
}
```

---

## 3. Cambios en el cliente (`src/`)

### 3.1 Modificar `src/hooks/useRealtimeData.js`

- **Eliminar** la lógica de integración trapezoidal del cliente
- **Recibir** `accumulated` y `completedPeriods` del mensaje WebSocket
- **Al montar**, hacer fetch a `/api/periods/today` para obtener periodos completados antes de que el WS conecte

```js
// Al recibir mensaje WS:
if (msg.accumulated) setAccumulated(msg.accumulated)
if (msg.completedPeriods) setCompletedPeriods(prev => {
  // Merge: lo del servidor tiene prioridad
  const merged = { ...prev }
  for (const [unitId, hours] of Object.entries(msg.completedPeriods)) {
    merged[unitId] = { ...merged[unitId], ...hours }
  }
  return merged
})

// Al montar:
useEffect(() => {
  fetch('/api/periods/today')
    .then(r => r.json())
    .then(rows => {
      const periods = {}
      for (const row of rows) {
        if (!periods[row.unit_id]) periods[row.unit_id] = {}
        periods[row.unit_id][row.hora] = row.energia_mwh
      }
      setCompletedPeriods(periods)
    })
    .catch(() => {})
}, [])
```

---

## 4. Variables de entorno nuevas

Agregar al `.env`:

```env
# MSSQL Database
DB_HOST=<ip-o-hostname-del-servidor-sql>
DB_NAME=dashboard_gen
DB_USER=<usuario>
DB_PASSWORD=<password>
```

---

## 5. Resumen de flujo

1. **Scraper** extrae MW del PME cada ~3 segundos
2. **Accumulator** (servidor) hace integración trapezoidal y mantiene el acumulado en memoria
3. Cada **30 segundos**, el acumulado se persiste en `generacion_acumulado` (checkpoint)
4. Al **cambiar de hora**, el periodo completado se guarda en `generacion_periodos`
5. El **WebSocket** envía a los clientes: `{ units, accumulated, completedPeriods }`
6. Al **abrir la página**, el cliente hace GET `/api/periods/today` para cargar periodos previos
7. Si el **servidor se reinicia**, recupera el estado del periodo actual desde `generacion_acumulado`

### Qué se gana

| Escenario | Antes | Después |
|---|---|---|
| Refrescar página | Pierde todo | Recupera periodos + acumulado actual |
| Abrir otra pestaña | Empieza de 0 | Mismos datos que la primera |
| Reiniciar servidor | Pierde todo | Recupera desde checkpoint (~30s de pérdida máx) |
| Reiniciar servidor entre periodos | Pierde periodos pasados | Recupera de DB |
