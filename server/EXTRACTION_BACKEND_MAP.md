# Mapa del backend de extracción (medidores ION8650 directos)

Reemplaza al antiguo `PME_BACKEND_MAP.md`. La extracción ya no depende del PME centralizado vía Playwright; ahora consulta directamente cada medidor Schneider PowerLogic ION8650 por HTTP.

> **Flujo en una línea:** `meterClient.js` (HTTP Basic Auth + cheerio sobre `Operation.html`) ↔ `meterPoller.js` (orquestador con polling + agregación) → `server.js` (broadcast WebSocket) → `accumulator.js` (MW→MWh trapezoidal) + `projectionCalculator.js` → `db.js` (esquema `dashboard`).

---

## 1. `meterClient.js` — Cliente HTTP por medidor

**Clase principal:** `ION8650Client`

Una instancia por medidor físico. Responsabilidad única: una petición → un valor numérico de `kW total`.

- **Autenticación**: HTTP Basic (`Authorization: Basic base64(user:password)`).
- **Path**: `/Operation.html` por defecto (configurable vía `METER_OP_PATH`). Confirmado en firmware `8650V409`.
- **Selector**: `<td class="l">kW total</td>` → next sibling `<td class="v">5240.04 kW</td>`. Estable porque las clases `l` (label) y `v` (value) son parte del template del firmware ION.
- **Timeout**: 4s default (`METER_TIMEOUT_MS`). `AbortSignal.timeout()` + `headersTimeout`/`bodyTimeout` de undici.
- **Keep-alive**: `undici.Agent` reutilizable; el poller pasa un agent compartido para amortizar handshakes TCP.

**Errores tipados** (subclases de `MeterError`):
- `MeterAuthError` — HTTP 401.
- `MeterHttpError` — otros 4xx/5xx.
- `MeterTimeoutError` — timeout de conexión, headers o body.
- `MeterFormatError` — el HTML respondió 200 pero la celda `kW total` no existe / la unidad no es ` kW` / el número no es finito. Señal de cambio de firmware: el operador debe verlo, no es transitorio.

**API:**
- `fetchKwTotal()` → `{ kw, fetchedAt, latencyMs }`.
- `close()` — cierra el agent si lo creó la propia instancia.

**Cero kW es dato válido** (unidad parada). El cliente nunca convierte `0.00 kW` a null; solo errores devuelven null aguas arriba.

---

## 2. `meterPoller.js` — Orquestador (reemplaza `PMEScraper`)

**Clase principal:** `MeterPoller` — **misma API pública que el viejo `PMEScraper`**: `start()`, `stop()`, `getStatus()`, callback `onData(payload)`. Por eso `server.js` solo cambia su línea de instanciación; `broadcast()`, `/health`, `accumulator.update()` se quedan iguales.

**Constructor:** `{ units, onData, pollMs?, timeoutMs?, opPath?, clientFactory? }`. `clientFactory` es opcional (los tests inyectan mocks).

**Loop:**
- `start()` programa `setInterval(this.#tick, pollMs)` y dispara un primer tick inmediato.
- Cada tick: `Promise.all(units.map(readUnit))`. `readUnit` a su vez hace `Promise.all(meters.map(client.fetchKwTotal))` por unidad.
- Combina por unidad:
  - `combine: 'single'` → `valueMW = kw / 1000`.
  - `combine: 'sum'` (GEC3) → `valueMW = (kw_a + kw_b) / 1000`.
  - **Si CUALQUIER medidor de una unidad falla en un tick, `valueMW = null`** para esa unidad. No reportamos parciales (subreportarían MWh y contaminarían el integrador trapezoidal del acumulador).
- Construye payload `{ type: 'update', units: [{id, label, valueMW, maxMW}, ...], timestamp }` y llama `this.onData(payload)`. **Mismo shape que emitía el `PMEScraper`.**

**Aislamiento:** la falla del medidor de TGJ2 no afecta a TGJ1/GEC3/GEC32. Cada unidad tiene su propia rama de `Promise.all`; un rechazo no propaga.

**Inversión de signo por frontera de medición:** TGJ1/TGJ2 miden en frontera de salida (signo coincide con el PME), GEC3/GEC32 miden en frontera de entrada (signo opuesto al PME, así que el poller invierte). Detalle físico y verificación con datos reales en [`SIGN_CONVENTION.md`](./SIGN_CONVENTION.md). Configurado vía `frontierType: 'output' | 'input'` por unidad en `config.js`.

**Watchdog/heartbeat (sin browser que reiniciar):**
- `STALE_WARNING_MS = 30s` por medidor → log `warn`.
- `STALE_THRESHOLD_MS = 60s` por medidor → log `error`.
- `HEARTBEAT_MS = 60s` global mantiene un log de vida.
- El campo `stale` (consumido por `/health`) se vuelve `true` solo cuando **todos** los medidores están stale al mismo tiempo (no si solo uno está caído — eso es problema puntual de un medidor, no de la extracción).

**`getStatus()`** retorna shape compatible con `PMEScraper.getStatus()`:
- `running, warming, lastDataAt, secondsSinceUpdate, updateCount, errorCount, stale` (igual que antes).
- **Plus:** `perMeter[unitId@host] = { lastOkAt, secondsSinceOk, consecutiveErrors, lastError }`. Esto es nuevo y útil — `/health` muestra exactamente qué medidor está fallando sin tener que leer logs.

---

## 3. `config.js` — Topología de unidades y medidores

Reemplaza al antiguo modelo DOM-acoplado (`referencia` + `occurrence`):

```js
export const UNITS = [
  { id: 'TGJ1',  label: 'GUAJIRA 1',   maxMW: 145, combine: 'single', meters: [{host, user, password}] },
  { id: 'TGJ2',  label: 'GUAJIRA 2',   maxMW: 130, combine: 'single', meters: [{host, user, password}] },
  { id: 'GEC3',  label: 'GECELCA 3',   maxMW: 164, combine: 'sum',    meters: [{...A}, {...B}] },
  { id: 'GEC32', label: 'GECELCA 32',  maxMW: 270, combine: 'single', meters: [{host, user, password}] },
]
```

Más `METER_DEFAULTS` con `{ opPath, pollMs, timeoutMs }` para tunear sin tocar código.

**Validación al cargar**: el módulo levanta una excepción con la lista de variables de entorno faltantes. Fail-fast en el arranque del server. Para herramientas que importen `UNITS` sin tener la red configurada (tests, scripts ad-hoc), se puede saltar con `CONFIG_SKIP_VALIDATION=1`.

---

## 4. `server.js` — Cambio quirúrgico

Solo se modifican 2 zonas:

```diff
- import { PMEScraper } from './scraper.js'
- import { UNITS, PME } from './config.js'
+ import { MeterPoller } from './meterPoller.js'
+ import { UNITS, METER_DEFAULTS } from './config.js'

- const scraper = new PMEScraper({ pme: PME, units: UNITS, onData: broadcast })
+ const scraper = new MeterPoller({ units: UNITS, onData: broadcast, ...METER_DEFAULTS })
```

Todo el resto (`broadcast()`, `/health`, `scraper.start()/stop()`, `accumulator.update()`, persistencia, WebSocket, etc.) **permanece idéntico**. La variable se sigue llamando `scraper` para que el monitoreo externo no requiera cambios.

---

## 5. `accumulator.js`, `projectionCalculator.js`, `db.js` — sin cambios

Lo que hacen y cómo lo hacen no cambia:

- `EnergyAccumulator.update(units)` lee solo `unit.id` y `unit.valueMW`. Acepta `0` como válido y `null` como "sin dato" (no acumula). Eso es lo que el poller produce.
- `computeLive` / `computeClosed` siguen siendo funciones puras.
- `db.js` mantiene esquema `dashboard.*` (`generacion_periodos`, `generacion_acumulado`, proyección, desviación). Misma persistencia.

---

## 6. `scripts/probe-meters.js` — Herramienta de descubrimiento

Standalone. Recorre `UNITS`, golpea cada medidor con timeout corto y reporta tabla:

```
UNIT   M  HOST                    STATUS  kW            LAT/INFO
─────────────────────────────────────────────────────────────────────
TGJ1   m0 192.168.200.10          OK      140.32        120ms
TGJ2   m0 192.168.200.11          OK      128.50        98ms
GEC3   m0 192.168.200.12          OK      80.10         110ms
GEC3   m1 192.168.200.13          FAIL    —             MeterAuthError: 401 Unauthorized
GEC32  m0 192.168.200.14          OK      265.00        130ms
```

Útil para diagnosticar antes de tocar `server.js` cuando se cambian credenciales/medidores/firmware.

---

## 7. Tests (vitest)

- `__tests__/meterClient.test.js` — 13 casos. Usa fixture `__fixtures__/ion8650_op.html` (HTML real capturado del medidor). Valida: extracción del valor `5240.04`, manejo de Basic Auth, errores tipados (`MeterAuthError`, `MeterHttpError`, `MeterFormatError`, `MeterTimeoutError`), comportamiento ante HTML mutilado, cero/negativo, custom `opPath`, host con/sin scheme.
- `__tests__/meterPoller.test.js` — Inyecta `clientFactory` mock. Valida: shape del payload coincide con `PMEScraper`; suma de GEC3; null en GEC3 cuando un medidor falla; aislamiento entre unidades; cero MW preservado; `getStatus()` shape; `stop()` cancela ticks.

`fixtures/ion8650_op.html` es el contrato real con el firmware `8650V409`. Si los tests verdes después de un cambio de firmware fallan, hay que actualizar el fixture (recapturar con `curl`) y revisar el selector.

---

## Resumen visual del pipeline

```
   ┌─────────────────────────────────────────┐
   │ config.js (UNITS con meters[],          │
   │ valida env vars al cargar)              │
   └────────────────┬────────────────────────┘
                    │ inyección
                    ▼
   ┌─────────────────────────────────────────┐
   │ meterPoller.js (MeterPoller)            │
   │  · setInterval(pollMs)                  │
   │  · Promise.all por unidad ↔ medidores   │
   │  · combine: single | sum (GEC3)         │
   │  · staleness por-medidor                │
   │  · getStatus.perMeter para /health      │
   └────────────────┬────────────────────────┘
                    │ onData({type:'update', units, timestamp})
                    ▼            ↑ MISMO CONTRATO QUE PMEScraper
   ┌─────────────────────────────────────────┐
   │ server.js broadcast() (sin cambios)     │
   └────────────────┬────────────────────────┘
                    │
                    ▼
   accumulator.js · projectionCalculator.js · db.js (sin cambios)
                    │
                    ▼
   ┌─────────────────────────────────────────┐
   │ MSSQL — esquema dashboard               │
   │  generacion_periodos · generacion_acumulado │
   │  proyeccion_* · desviacion_*            │
   └─────────────────────────────────────────┘
```

---

## Variables de entorno

Se cargan automáticamente desde `pruebas/.env` (Node `--env-file`). Plantilla en `.env.example`.

| Variable | Default | Uso |
|---|---|---|
| `USER_MEDIDORES` | — | Usuario único para Basic Auth en los 5 medidores. |
| `IP_TGJ1` / `PSW_TGJ1` | — | Host y password del medidor de TGJ1. |
| `IP_TGJ2` / `PSW_TGJ2` | — | Host y password del medidor de TGJ2. |
| `IP_GEC32` / `PSW_GEC32` | — | Host y password del medidor de GEC32. |
| `IP_GEC3_1` / `PSW_GEC3_1` | — | Host y password del medidor #1 de GEC3 (sumando). |
| `IP_GEC3_2` / `PSW_GEC3_2` | — | Host y password del medidor #2 de GEC3 (sumando). |
| `METER_BASIC_USER` / `METER_BASIC_PASS` | — | Fallback global (si por alguna razón `USER_MEDIDORES` no se define). |
| `METER_OP_PATH` | `/Operation.html` | Path de la página con `kW total`. Cambia entre versiones de firmware ION. |
| `METER_POLL_MS` | `2000` | Intervalo de polling. Equivalente práctico al cadencia event-driven del PME. |
| `METER_TIMEOUT_MS` | `4000` | Timeout por fetch. Debe ser `<` `pollMs` para no encolar. |
| `CONFIG_SKIP_VALIDATION` | — | `1` para saltar validación de env vars al cargar `config.js` (tests, scripts). |

Las variables del PME viejo (`PME_LOGIN_URL`, `PME_DIAGRAM_URL`, `PME_USER`, `PME_PASSWORD`, `HEADLESS`) están **obsoletas** y se pueden eliminar del entorno.

---

## Comparativa antes/después

| Aspecto | Antes (PME + Playwright) | Después (medidores directos) |
|---|---|---|
| Fuente | 1 PME centralizado (SPOF) | 5 medidores independientes |
| Stack runtime | Node + Chromium (Playwright) | Node puro (`fetch`/`undici` + `cheerio`) |
| Falla cruzada | Sí — PME pegao = todas las unidades sin dato | No — medidor caído ≠ otros |
| Recuperación | Reinicio de browser ~60s | Próximo poll (~2s) |
| Acoplamiento | DOM (`referencia` + `occurrence` + index posicional) | HTTP (`host` + selector por clase CSS estable) |
| Footprint deploy | ~300 MB (Chromium incluido) | ~5 MB (cheerio + undici) |
| Tests | 0 | 20+ casos con fixture HTML real |
| Visibilidad de fallas | `stale` global | `perMeter` por unidad/host en `/health` |
