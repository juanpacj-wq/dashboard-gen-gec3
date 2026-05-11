# Arquitectura — dashboard-gen-gec3

Dashboard de generación eléctrica para Gecelca (GEC3). React 19 + Vite (SPA, sin router ni state library) + Node WS backend (puerto 3001) que orquesta extracción de medidores ION8650 + scrapers XM + EmailDispatch + MSSQL.

Este archivo da el panorama. Para detalle del extractor de medidores ver `../server/EXTRACTION_BACKEND_MAP.md` (autoritativo). Para convención de signos crítica ver `../server/SIGN_CONVENTION.md`.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 19, Vite 5, estilos inline (objetos JS), sin Tailwind, sin router, sin state library |
| Backend | Node.js ≥20, http nativo, ws (WebSocket), undici (HTTP keep-alive), playwright (PME hot-standby) |
| BD | SQL Server 2019+, driver `mssql`, esquema `dashboard` |
| Tests | Vitest forks (`--pool=forks` para el orchestrator), 15+ tests existentes |
| Build | Vite (`npm run build` → `dist/`), deploy Ubuntu + nginx + systemd |
| Subproyecto Python | `fabric-meter-sink/` — escribe lecturas de medidores a Microsoft Fabric Lakehouse. Tiene su propio CLAUDE.md. |

---

## Cinco backend services orquestados por `server.js`

1. **Extractor (medidores ION8650 + PME hot-standby)** — `ExtractorOrchestrator` arbitra entre `MeterPoller` (primario) y `PMEScraper` (fallback). State machine por unidad: 3 errores meter → switch a PME; 2 OK consecutivos → recovery. Tick cada 2s. Ver D-101 en `decisions.md`.
2. **Energy Accumulator** (`accumulator.js`) — integra trapezoidalmente las lecturas MW en MWh por periodo horario Colombia. Checkpointea cada 30s a `dashboard.generacion_acumulado` para recuperación post-restart.
3. **Email Dispatch** (`emailDispatch.js`) — Microsoft Graph API lee redespacho notification emails de un mailbox compartido, parsea MW per unidad/periodo, persiste a `dashboard.despacho_final`. Fallback a XM `GeneProgRedesp` al minuto 55 de cada hora. Email filter desde `T01:00:00Z` (8 PM Colombia previo) para capturar early-period emails.
4. **Redespacho Scraper** (`redespachoscraper.js`) — descarga `rDECMMDD.txt` de XM portal cada 5 min, parsea nuestras 4 unidades + todas las plantas nacionales (para ticker). Persiste a `dashboard.redespacho_programado` con audit log en `dashboard.redespacho_historico`.
5. **Despacho Scraper** (`despachoscraper.js`) — descarga `dDECMMDD_TIES.txt` una vez por día (retry cada 5 min hasta encontrarlo, después se detiene). Persiste a `dashboard.despacho_programado` INSERT-only.

---

## Capa de extracción (medidores ION8650)

**Reemplazó al PME centralizado** (commits `07f19b3..296315d` migraron de `PMEScraper` único a `ExtractorOrchestrator` con MeterPoller + PMEScraper hot-standby). Detalles completos en `../server/EXTRACTION_BACKEND_MAP.md`.

**Componentes:**

- `meterClient.js` — `ION8650Client`. Una instancia por medidor físico. HTTP Basic + cheerio sobre `/Operation.html` (firmware ION 8650V409). Errores tipados: `MeterAuthError`, `MeterHttpError`, `MeterTimeoutError`, `MeterFormatError`. Timeout 4s default. Keep-alive via undici Agent compartido.
- `meterPoller.js` — `MeterPoller`. Misma API pública que el viejo `PMEScraper` (`start/stop/getStatus/onData`). Polling concurrente con `Promise.all` por unidad y por medidor. **Aislamiento por unidad**: si CUALQUIER medidor de una unidad falla en un tick, esa unidad reporta `valueMW=null` para no contaminar el integrador. Inversión de signo a nivel unidad (después de combinar). `perMeter` en `getStatus()` permite saber qué medidor está fallando sin leer logs.
- `extractorOrchestrator.js` — árbitro entre MeterPoller y PMEScraper. State machine por unidad con histeresis. Expone `source: 'meter' | 'pme' | null` en el payload WS (decisión D-102).
- `scraper.js` — `PMEScraper` (Playwright). Quedó como hot-standby. Logueado al PME centralizado de Gecelca, observa mutaciones del diagrama balance.dgm.
- `config.js` — `UNITS` con `{ id, label, maxMW, combine: 'single'|'sum', meters: [{host, user, password}], frontierType: 'input'|'output' }`. Validación fail-fast al cargar.

**Topología de medidores:**

| Unidad | maxMW | Medidores | Combine | frontierType |
|---|---|---|---|---|
| TGJ1 (GUAJIRA 1) | 145 | 1 | single | output |
| TGJ2 (GUAJIRA 2) | 130 | 1 | single | output |
| GEC3 (GECELCA 3) | 164 | 2 (suman) | sum | input (signo invertido) |
| GEC32 (GECELCA 32) | 270 | 1 | single | input (signo invertido) |

5 medidores físicos repartidos en 4 unidades. Ver `../server/SIGN_CONVENTION.md` para el detalle físico de por qué Gecelca tiene signo invertido.

---

## Endpoints REST

Todos servidos por `server.js` en puerto 3001:

| Endpoint | Método | Propósito | Shape respuesta |
|---|---|---|---|
| `/health` | GET | Health + status del orchestrator | `{ status, clients, pme: { perUnit, perMeter, ... } }` |
| `/api/periods/today` | GET | Periodos completados del día | `[{ unit_id, hora, energia_mwh }]` |
| `/api/despacho-final/today` | GET | Despacho final de EmailDispatchService | `{ GEC3: { 1: {valor_mw, source}, ... }, ... }` (objeto por unidad+periodo) |
| `/api/despacho/today` | GET | Despacho programado del dDEC | `{ GEC3: [24 MW], ... }` |
| `/api/redespacho/today` | GET | Redespacho programado del rDEC | `{ GEC3: [24 MW], ... }` |
| `/api/redespacho/national` | GET | Todas las plantas nacionales del rDEC (para ticker) | `[{ code, name, values: [24 MW] }]` |
| `/ws` | WebSocket | Real-time: `{ type: 'update', units: [{id, label, valueMW, maxMW, source}, ...] }` enriquecido con projection/accumulated/despacho final |

**Endpoint hacia Bit-cora-g3** (consumido, no expuesto): `GET http://<bit-cora-host>:3002/api/eventos-dashboard?tipo=&planta_id=` — ver `../../docs/interfaces-cross-repo.md`.

---

## Frontend

```
dashboard-gen-gec3/src/
├── main.jsx                       Entry: <Dashboard />
├── Dashboard.jsx                  Layout: nav, ticker, cards, chart, tabla, footer
├── theme.js                       Paleta C (incluye amberDim/amberBorder post-M3)
├── data/
│   ├── units.js                   UNITS, ALL_DATA mock, seedRng, calcStats
│   └── plantNames.js              Mapping código → nombre (ticker)
├── hooks/
│   ├── useRealtimeData.js         WebSocket /ws. Propaga units[].source SIN transformación (M2).
│   ├── useXmGeneration.js         Polling /api/redespacho/national (5 min). Top 10 ticker.
│   └── useXmDispatch.js           Polling /api/despacho/today y /api/redespacho/today (5 min, .catch independientes).
└── components/
    ├── GenerationTicker.jsx       Top 10 nacional (lee de rDEC, NO de XM API).
    ├── MiniGauge.jsx              SVG animado.
    ├── UnitCards.jsx              Cards seleccionables. Badge MEDIDOR/PME por unidad (M3).
    ├── Chart.jsx                  Control chart CEP (deviation % con UCL/LCL).
    └── Table.jsx                  Tabla 24h con highlight del periodo actual.
```

### Hook `useRealtimeData.js`

WebSocket cliente a `/ws`. El backend (ExtractorOrchestrator) envía cada unit con shape `{ id, label, valueMW, maxMW, source: 'meter' | 'pme' | null }`. **Se propaga tal cual (sin spread/map/filter)** — `setUnits(msg.units)` directo. Cualquier transformación rompe el contrato.

### Badge MEDIDOR/PME (M3)

En el header de cada `UnitCard`, un mini-badge:
- `source === 'meter'` → "MEDIDOR" en verde (`C.green` / `C.greenDim` / `C.greenBorder`).
- `source === 'pme'` → "PME" en ámbar (`C.amber` / `C.amberDim` / `C.amberBorder`).
- `source === null` → no se renderiza nada (evita parpadeo durante warming).

Si el orchestrator switchea meter→pme por fallo, el badge cambia en ≤6s (3 ticks de 2s = fallbackThreshold).

### Estilos

Todo inline (objetos JS). Constantes en `theme.js`:
- `C` — colores (verde/cyan/azul/ámbar/rojo + variantes Dim/Border).
- `FONT`, `MONO` — font stacks.

Sin Tailwind, sin CSS modules, sin styled-components.

---

## Base de datos

MSSQL `dashboard_gen` por defecto. 6 tablas en esquema `dashboard`:

| Tabla | Propósito |
|---|---|
| `generacion_periodos` | Periodos horarios cerrados (unit, fecha, hora, MWh). |
| `generacion_acumulado` | Checkpoint live por unidad (recuperación post-restart). |
| `despacho_final` | Despacho final por unidad/periodo, source `email` o `xm_fallback`. CHECK constraint. |
| `despacho_programado` | dDEC — INSERT-only, una escritura por unit/fecha/periodo. |
| `redespacho_programado` | rDEC — UPSERT, tracks `version` por registro. |
| `redespacho_historico` | Audit log de cambios redespacho. Una fila por cambio detectado con `valor_mw_prev` y `valor_mw_new`. Indexed `(fecha, unit_id, periodo)`. |

**Decisiones clave de BD:**
- 0 MW es dato válido (e.g., Guajira 1 no despachado). Save functions usan `if (valor == null) continue`, NO `=== 0`.
- `saveRedespachoProgBulk` detecta cambios con threshold `Math.abs(existing - new) > 0.01` y logea a `redespacho_historico`.
- `saveDespachoProgBulk` es INSERT-only.

---

## Vite dev proxies (`vite.config.js`)

Vite proxy a `http://localhost:3001`:
- `/api/xm/*` → `https://servapibi.xm.com.co` (CORS).
- `/ws` → WebSocket upgrade.
- `/api/periods/*`.
- `/api/despacho-final/*` — **DEBE listarse ANTES de `/api/despacho`** (conflicto de prefijo).
- `/api/despacho/*`.
- `/api/redespacho/*`.

Producción: nginx (`deploy/nginx.conf`) replica los mismos proxies. **Cuando se agrega un endpoint, hay que agregar el proxy en AMBOS lugares**.

---

## Deploy (Ubuntu)

```
/var/www/dashboard-gen/
├── dist/                    Build de Vite (estático servido por nginx)
└── server/                  Backend Node ejecutado por systemd
```

**Comandos típicos:**
```bash
cd /var/www/dashboard-gen && git pull && npm run build && cd server && npm ci && sudo systemctl restart dashboard-ws
```

Si cambió `nginx.conf`:
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-enabled/dashboard-gen
sudo nginx -t && sudo systemctl reload nginx
```

**Debugging deploy:**
```bash
sudo journalctl -u dashboard-ws -f
curl -s http://localhost:3001/health
curl -s http://localhost:3001/api/despacho-final/today
curl -s http://localhost:3001/api/redespacho/national | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.length,'plants');console.log(j.slice(0,3))})"
```

---

## Variables de entorno (`.env` en raíz del repo, leído via `--env-file`)

- `WS_PORT` — default 3001.
- `PME_LOGIN_URL`, `PME_DIAGRAM_URL`, `PME_USER`, `PME_PASSWORD` — PME hot-standby.
- `METER_*_HOST`, `METER_*_USER`, `METER_*_PASSWORD` — 5 medidores (TGJ1, TGJ2, GEC3_A, GEC3_B, GEC32). Validación fail-fast en `config.js`.
- `METER_OP_PATH`, `METER_POLL_MS`, `METER_TIMEOUT_MS` — defaults configurables.
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT` — MSSQL. Named instances soportadas via `DB_HOST=host\instance`.
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX` — Email dispatch. **Deben estar en local AND server**.
- `HEADLESS` — `false` para Playwright visible (PME debug).

---

## Convenciones clave

1. **TZ Colombia (UTC-5 sin DST)** en cálculos operativos. Helpers: `colombiaSecondsInHour`, `colombiaNow`. Filtro email dispatch desde `T01:00:00Z` (8 PM previo Colombia).
2. **Negative PME clamping**: lecturas PME pueden tener spikes negativos que propagarían al acumulador y a la proyección. Frontend clampa a `>=0` en display: `final_` (Table.jsx), `proyGeneracion` (Table.jsx), `deviation` recomputada con `Math.max(0, projection)` contra `redespacho` en Table.jsx (periodo actual) y UnitCards.jsx (formula: `((clampedProj - redespacho) / redespacho) * 100`).
3. **Inversión de signo** en `meterPoller.js` para frontera `input` (Gecelca). Aplicada a nivel unidad después de combinar. Ver `../server/SIGN_CONVENTION.md`.
4. **`despacho-final` antes de `despacho`** en proxies (prefijo conflict).
5. **El TOTAL line en rDEC files** se filtra en `parseAllPlants()` para no aparecer en Top 10.
6. **Plant name normalization**: uppercase + remove spaces (`"GECELCA 3"` → `"GECELCA3"`) para matching.

---

## Verificación

**Tests** (`cd server && npm test`):
- `extractorOrchestrator.test.js` — 15+ tests con vitest forks. Cubre histeresis, switch meter→pme, source flow.
- `meterPoller.test.js` — convención de signos, aislamiento por unidad, watchdog.

**Smoke manual:**
```bash
cd dashboard-gen-gec3/server && npm run dev       # backend 3001
cd dashboard-gen-gec3 && npm run dev              # frontend (vite)
# Browser http://localhost:5173 → cards muestran badge MEDIDOR/PME
# F12 → Network → WS → frame con {units:[{source}]}
curl http://localhost:3001/health | jq '.pme.perUnit'  # cross-check source
```

**Subproyecto Python (`fabric-meter-sink/`):**
```bash
cd dashboard-gen-gec3/fabric-meter-sink && python -m pytest  # 42 tests
```
Ver `fabric-meter-sink/CLAUDE.md` para más detalle.
