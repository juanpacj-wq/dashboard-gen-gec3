# Mapa de archivos backend que sirven datos del PME

Este documento lista únicamente los archivos del backend (`server/`) involucrados en la captura, procesamiento, persistencia y entrega de los datos del **PME** (Power Monitoring Expert de Gecelca, `gpme.gecelca.com.co`). No incluye archivos de redespacho, despacho XM, email dispatch ni frontend.

> **Flujo PME en una línea:** `scraper.js` (Playwright lee el diagrama PME) → `accumulator.js` (integra MW→MWh) + `projectionCalculator.js` (proyección en vivo) → `db.js` (persistencia) → `server.js` (broadcast vía WebSocket a clientes).

---

## 1. `server/scraper.js` — PME Scraper (núcleo de captura)

**Clase principal:** `PMEScraper`

Es el corazón de la integración con el PME. Usa **Playwright (Chromium)** para:

- Iniciar sesión en `PME.loginUrl` con las credenciales `PME_USER` / `PME_PASSWORD`.
- Navegar al diagrama de balance de potencia (`PME_DIAGRAM_URL`, parámetro `dgm=balance.dgm`).
- Observar mutaciones del DOM en la tabla HTML del diagrama para detectar cambios de los valores `kW tot`, `KWTOT_G3` y `KWTOT_G32`.
- Por cada cambio, extraer el valor en kW de cada unidad usando la combinación `referencia` + `occurrence` definida en `config.js`, convertirlo a MW (`/1000`) y emitir el lote vía el callback `onData`.
- Reconectar automáticamente con backoff (`RECONNECT_MS = 5s`) ante fallos de sesión o navegación.

**Watchdog y heartbeat (anti-PME-pegao):**
- `WATCHDOG_INTERVAL_MS = 10s` — chequea staleness.
- `STALE_WARNING_MS = 30s` — emite warning si no hay datos.
- `STALE_RESTART_MS = 60s` — fuerza reinicio del browser/sesión si no llega ningún dato.
- `HEARTBEAT_MS = 60s` — log periódico de vida.
- `DEBOUNCE_MS = 300` — agrupa mutaciones rápidas para evitar emitir múltiples updates por el mismo cambio.

**API pública:**
- `start()` — inicia el loop de scraping (con watchdog/heartbeat activos).
- `stop()` — apaga browser, watchdog y heartbeat.
- `getStatus()` — retorna `{ running, warming, lastDataAt, secondsSinceUpdate, updateCount, errorCount, stale }`. Lo consume `server.js` para exponer salud del scraper.

**Entrada:** credenciales PME + lista de unidades (vía constructor).
**Salida:** llamadas al callback `onData(units)` con `[{ id, valueMW, ... }]`.

---

## 2. `server/config.js` — Configuración del PME y unidades

Define dos exports usados exclusivamente por la cadena PME:

- **`PME`** — objeto con `loginUrl`, `diagramUrl`, `user`, `password`. Toma valores de variables de entorno (`PME_LOGIN_URL`, `PME_DIAGRAM_URL`, `PME_USER`, `PME_PASSWORD`) con un `DEFAULT_DIAGRAM_URL` hardcodeado al diagrama `balance.dgm` del servidor `BQ-ENERGIA-07`.
- **`UNITS`** — definiciones de las 4 unidades de generación que el scraper debe extraer del diagrama:
  - `id` — identificador interno (`TGJ1`, `TGJ2`, `GEC3`, `GEC32`).
  - `label` — nombre legible (`GUAJIRA 1`, `GUAJIRA 2`, `GECELCA 3`, `GECELCA 32`).
  - `referencia` — texto de etiqueta visible en el DOM del diagrama (`kW tot` para Guajiras, `KWTOT_G3` y `KWTOT_G32` para Gecelca).
  - `occurrence` — índice base 0 de la N-ésima aparición de la etiqueta en el DOM. Imprescindible para Guajira 1 (occurrence 0) y Guajira 2 (occurrence 1) porque ambas comparten la etiqueta `kW tot`.
  - `maxMW` — capacidad máxima (TGJ1=145, TGJ2=130, GEC3=164, GEC32=270). Usado por el frontend para los gauges, pero declarado aquí porque pertenece al modelo de la unidad PME.

Es el único punto donde se conecta el modelo del DOM del PME con el modelo de unidades de la app.

---

## 3. `server/server.js` — Orquestador y broadcast en vivo

No captura datos del PME, pero es el archivo que **conecta** la salida del scraper con los clientes WebSocket y la base de datos. Responsabilidades específicas del flujo PME:

- Instancia el scraper:
  ```js
  const scraper = new PMEScraper({ pme: PME, units: UNITS, onData: broadcast })
  ```
- En `start()`/al final del bootstrap: llama `scraper.start()`.
- `broadcast(payload)` — recibe los lotes de unidades del scraper, los enriquece con:
  - acumulado MWh del periodo en curso (desde `EnergyAccumulator`),
  - periodos completados del día,
  - promedios por minuto,
  - despacho final (email/XM) ya mergeado,
  - proyección en vivo (`computeLive`) y desviación.
- Envía el payload por WebSocket (mensaje `{ type: "update", units: [...] }`) a todos los clientes conectados.
- Expone el endpoint `GET /health` que incluye `scraper.getStatus()` para monitoreo externo.
- Mantiene el mapa en memoria de proyecciones de cierre por unidad/periodo (precargado desde DB en arranque para que los clientes que se conecten después tengan el histórico del día).

Flujo: **scraper → onData=broadcast → accumulator.update() → DB + WebSocket clients**.

---

## 4. `server/accumulator.js` — Acumulador de energía (MW → MWh)

**Clase principal:** `EnergyAccumulator`

Convierte la serie de lecturas instantáneas en MW emitidas por el scraper en MWh por periodo horario (1–24, hora local Colombia UTC-5 sin DST).

**Estado en memoria:**
- `#state[unitId]` — `{ mwh, lastMW, lastTime, hour, date }` por unidad para el periodo en curso.
- `#completed[unitId][hour]` — MWh ya cerrados del día.
- `#minuteBuckets` y `#minuteDevBuckets` — sumatorias para promedios por minuto (60 cubetas por hora).

**Métodos clave:**
- `init()` — restaura el estado desde `loadAccumState()` (DB) si la app reinicia dentro del mismo periodo, evitando perder MWh acumulados. Programa un `setInterval(persistState, 30s)`.
- `update(units)` — invocado en cada update del scraper; integra trapezoidalmente `(MW_prev + MW_actual)/2 × Δt` y suma al MWh del periodo. Detecta cambios de hora para cerrar el periodo anterior, llama `savePeriod()` y dispara `onPeriodComplete` (que persiste desviación de cierre vía `computeClosed` indirectamente).
- Calcula el promedio en vivo (`computeLive`) cuando lo solicita el broadcast.

**Importante:** un MW = 0 es dato válido (unidad no despachada). El acumulador no descarta ceros; sólo se evita acumular cuando `valueMW == null`.

---

## 5. `server/projectionCalculator.js` — Matemática pura de proyección y desviación

Funciones puras (sin estado, sin I/O) reutilizadas por `accumulator.js` (cierre de periodo) y `server.js` (broadcast en vivo). No tocan el PME directamente, pero son las que dan sentido a sus datos.

- **`colombiaSecondsInHour(date)`** — segundos transcurridos en la hora actual de Colombia (UTC-5 sin DST). Rango `[0..3599]`.
- **`computeLive({ acumuladoMwh, currentMw, redespachoMw, now })`** — proyección lineal del periodo en curso (lógica heredada del VB6 original):
  - `fraction = secs / 3600`
  - `projection = acumulado + currentMW × (1 − fraction)`
  - `deviation = ((projection − redespacho) / redespacho) × 100` (null si `redespacho ≤ 0`)
  - Aplica `Math.max(0, currentMw)` para clampar lecturas negativas espurias del PME.
- **`computeClosed({ generacionMwh, despFinalEmail, redespachoMw })`** — desviación de periodo cerrado, con preferencia de denominador: `email despFinal > redespacho fallback`. Devuelve `{ generacionMwh, despFinalMw, despFinalSource, desviacionPct }`.

---

## 6. `server/db.js` — Persistencia del PME (sólo funciones relevantes)

`db.js` administra todas las tablas del esquema `dashboard`, pero las funciones específicas del flujo **PME** son:

| Función | Tabla | Propósito |
|---|---|---|
| `savePeriod(unitId, fecha, hora, energiaMwh)` | `dashboard.generacion_periodos` | Inserta el MWh total de un periodo cerrado por unidad. |
| `saveAccumState(unitId, fecha, hora, energiaMwh, lastMW, lastTime)` | `dashboard.generacion_acumulado` | Checkpoint del acumulador en vivo cada 30 s para recuperación tras reinicio del proceso. |
| `loadAccumState()` | `dashboard.generacion_acumulado` | Lee el último checkpoint al arrancar; `EnergyAccumulator.init()` lo usa para reanudar el periodo en curso. |
| `saveProyeccionActual(unitId, payload)` | tabla de proyección actual | Guarda la proyección en vivo del periodo activo (consumida por dashboards externos / restart). |
| `saveProyeccionHistorico(unitId, payload)` / `saveProyeccionPeriodo(unitId, fecha, periodo, payload)` | tabla de proyección histórica | Persiste la proyección final por periodo cerrado. |
| `saveDesviacionPeriodo(unitId, fecha, periodo, payload)` | tabla de desviación | Guarda la desviación de cierre (resultado de `computeClosed`). |
| `getDB()` (god node, 22 edges) | — | Singleton de conexión MSSQL usado por todas las funciones anteriores. |

**Notas:**
- `getDB()` soporta instancias nombradas vía `DB_HOST=host\\instance` para entornos Gecelca on-prem.
- Cero MW es dato válido: las funciones de save usan `if (valor == null) continue`, **no** `=== 0`.

---

## Resumen visual del pipeline PME

```
                ┌──────────────────────┐
                │  config.js (PME,     │
                │  UNITS, occurrence)  │
                └──────────┬───────────┘
                           │ inyección
                           ▼
   ┌────────────────────────────────────────┐
   │ scraper.js  (PMEScraper + Playwright)  │
   │  · login + diagrama balance.dgm        │
   │  · MutationObserver kW tot/KWTOT_*     │
   │  · watchdog 60s + heartbeat            │
   └────────────────────┬───────────────────┘
                        │ onData(units in MW)
                        ▼
   ┌────────────────────────────────────────┐
   │ server.js  (broadcast + WS server)     │
   │  · enriquece con acumulado/proyección  │
   │  · broadcast({type:"update",units:[]}) │
   └─────┬──────────────────────────┬───────┘
         │                          │
         ▼                          ▼
┌──────────────────────┐  ┌──────────────────────┐
│ accumulator.js       │  │ projectionCalculator │
│ (MW → MWh trapecio,  │  │ .js (computeLive /   │
│  cierre de periodo)  │  │  computeClosed)      │
└──────────┬───────────┘  └──────────────────────┘
           │ savePeriod, saveAccumState,
           │ saveProyeccion*, saveDesviacion*
           ▼
┌──────────────────────────────────────────────┐
│ db.js  (MSSQL — esquema dashboard)           │
│  generacion_periodos · generacion_acumulado  │
│  proyeccion_* · desviacion_*                 │
└──────────────────────────────────────────────┘
```

---

## Variables de entorno usadas por el flujo PME

| Variable | Archivo que la lee | Uso |
|---|---|---|
| `PME_LOGIN_URL` | `config.js` | URL de login del PME. |
| `PME_DIAGRAM_URL` | `config.js` | URL del diagrama `balance.dgm`. |
| `PME_USER` | `config.js` | Usuario PME (default `supervisor`). |
| `PME_PASSWORD` | `config.js` | Contraseña PME. |
| `HEADLESS` | `scraper.js` | `false` para abrir Chromium visible (debug local). |
| `WS_PORT` | `server.js` | Puerto del WebSocket que difunde los datos PME. |
| `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_PORT` | `db.js` | Conexión MSSQL para persistencia de generación/acumulado/proyección/desviación. |
