# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Inicio rápido — qué leer

- **Detalle de arquitectura** (capas, scrapers, BD, deploy): `docs/architecture.md`.
- **Decisiones** (ADR-lite, migración a meters, badge MEDIDOR/PME, signos, etc.): `docs/decisions.md`.
- **Convención de signos crítica** (Gecelca frontier input vs Guajira output): `server/SIGN_CONVENTION.md`.
- **Mapa de archivos del extractor** (meterClient, meterPoller, extractorOrchestrator): `server/EXTRACTION_BACKEND_MAP.md`.
- **Subproyecto Python** (Fabric Lakehouse writer): `fabric-meter-sink/CLAUDE.md`.
- **Contrato cross-repo** (cómo se consume Bit-cora-g3): `../docs/interfaces-cross-repo.md`.

## Project Overview

Dashboard de generacion electrica para Gecelca (GEC3). Muestra datos de despacho/redespacho de unidades de generacion, graficas de control estadistico (CEP), y un ticker en tiempo real con el Top 10 de redespacho nacional extrayendo datos del archivo `rDECMMDD.txt` publicado por XM Colombia.

**Repo git independiente** dentro del workspace umbrella `PORTAL GENERACIÓN/`. Hermano de `Bit-cora-g3/`. Subproyecto Python `fabric-meter-sink/` vive adentro de este repo (sin `.git/` propio).

## Commands

- `npm run dev` — Start Vite dev server (includes proxy to backend)
- `npm run build` — Production build to `dist/`
- `npm run lint` — Run ESLint
- `npm run preview` — Preview production build locally
- `cd server && npm run dev` — Start backend server in watch mode (reads `.env` from project root)
- `cd server && npm start` — Start backend server in production mode

## Architecture

Single-page React 19 app built with Vite. No router, no state management library, no CSS framework — all styling is inline via JS objects.

### Key files

#### Frontend (`src/`)

- **`src/Dashboard.jsx`** — Main layout: nav, footer, and composition of all child components.
- **`src/theme.js`** — Color palette (`C`), font stacks (`FONT`, `MONO`).
- **`src/data/units.js`** — Unit definitions (`UNITS`), seeded PRNG (`seedRng`), mock data generator (`genUnitData`), precomputed data (`ALL_DATA`), stats helper (`calcStats`).
- **`src/data/plantNames.js`** — XM plant code → name mapping (`PLANT_NAME_MAP`).
- **`src/hooks/useXmGeneration.js`** — Hook that fetches national redespacho data from `/api/redespacho/national` (backed by `rDECMMDD.txt` file scraper). Shows Top 10 plants by current-hour MW. Falls back to simulated data on error, marked with "SIMULADO" badge.
- **`src/hooks/useXmDispatch.js`** — Hook that fetches despacho from `/api/despacho/today` (dDEC scraper) and redespacho from `/api/redespacho/today` (rDEC scraper). Both refresh every 5 min. Each fetch has independent `.catch()` so one failing doesn't kill the other.
- **`src/hooks/useRealtimeData.js`** — Hook that connects via WebSocket (`/ws`) to the PME server for real-time unit generation data. Also fetches `/api/periods/today` and `/api/despacho-final/today` on mount. Falls back gracefully to simulated data when the server is offline.
- **`src/components/GenerationTicker.jsx`** — Scrolling ticker showing Top 10 national redespacho (from rDEC file, NOT XM API).
- **`src/components/MiniGauge.jsx`** — Animated SVG gauge for capacity percentage.
- **`src/components/UnitCards.jsx`** — Selectable unit cards with stats summary.
- **`src/components/Chart.jsx`** — CEP control chart (deviation % with UCL/LCL).
- **`src/components/Table.jsx`** — 24h dispatch table with current-hour highlight.
- **`src/main.jsx`** — Entry point, renders `<Dashboard />` (not `<App />`).
- **`src/App.jsx`** — Vite template boilerplate, currently unused by the app.

#### Backend (`server/`)

- **`server/server.js`** — Node.js HTTP + WebSocket server (port 3001). Orchestrates all 5 backend services and exposes REST endpoints. Broadcasts real-time PME data to all connected dashboard clients.
- **`server/scraper.js`** — Playwright-based scraper that logs into Gecelca PME (`gpme.gecelca.com.co`), navigates to the balance diagram, and observes DOM mutations to extract live kW values per unit.
- **`server/config.js`** — PME credentials, diagram URL, and unit definitions (id, label, referencia, occurrence, maxMW) used by the scraper.
- **`server/despachoscraper.js`** — Despacho scraper service. Downloads the daily `dDECMMDD_TIES.txt` file from XM's portal API (`api-portalxm.xm.com.co`), parses it, and exposes 24 hourly MW values per unit (GEC3, GEC32, TGJ1, TGJ2). Retries every 5 min until file found, then stops for the day. Persists to DB; loads from DB only as fallback. Path: `Energia y Mercado/DESPACHO/TIES/Despachos/YYYY-MM/dDECMMDD_TIES.txt`.
- **`server/redespachoscraper.js`** — Redespacho scraper service. Downloads the daily `rDECMMDD.txt` file from XM's portal API, parses CSV-like content for our 4 units + all national plants. Refreshes every 5 minutes. Persists to DB with audit trail (detects changes, logs to `redespacho_historico`). Also exposes national plant data for the GenerationTicker via `getNational()`. Path: `M:/InformacionAgentes/Usuarios/Publico/Redespacho/YYYY-MM/rDECMMDD.txt`.
- **`server/emailDispatch.js`** — Email-based despacho final service. Uses Microsoft Graph API to read redespacho notification emails from a shared mailbox, parses MW values per unit/period, and stores them in MSSQL. Falls back to XM API (`GeneProgRedesp`) at minute 55 of each hour for missing periods. Runs every 5 minutes. Email filter starts at `T01:00:00Z` (8 PM Colombia previous day) to capture early period emails (periods 1, 2).
- **`server/accumulator.js`** — Energy accumulator. Integrates real-time MW readings over time to compute MWh per hourly period. Persists state to MSSQL for recovery across restarts. Tracks completed periods and per-minute averages.
- **`server/db.js`** — MSSQL database connection and schema management. Creates all tables in `dashboard` schema. Supports named instances via `DB_HOST`.

#### Deployment (`deploy/`)

- **`deploy/nginx.conf`** — Nginx config for production. Serves static `dist/` for the SPA, proxies `/ws` (WebSocket), `/api/xm/` (XM CORS), `/api/periods/`, `/api/redespacho/`, `/api/despacho/`, `/api/despacho-final/`, and `/health` to the Node.js backend on port 3001.
- **`deploy/dashboard-ws.service`** — systemd unit file for the WebSocket server. Runs as `www-data`, reads env from `/var/www/dashboard-gen/server/.env`.
- **`deploy/setup.sh`** — Full production setup script: installs Node.js 20, Nginx, Playwright/Chromium, builds frontend, configures Nginx and systemd.

### Data flow

1. **Simulated unit data**: `genUnitData()` in `src/data/units.js` generates deterministic mock data for 4 units (GEC3, GEC32, TGJ1, TGJ2) using a seeded PRNG. Each unit has 24 hourly periods with despacho/redespacho/final values. Used as fallback when server is offline.
2. **Despacho programado (dDEC scraper)**: `DespachoscraperService` downloads `dDECMMDD_TIES.txt` from XM portal once per day (retries every 5 min until found, then stops). Parsed values are exposed via `/api/despacho/today` and persisted to `dashboard.despacho_programado`. `useXmDispatch()` fetches this every 5 min.
3. **Redespacho programado (rDEC scraper)**: `RedespachoscraperService` downloads `rDECMMDD.txt` from XM portal every 5 minutes. Parses our 4 units + all national plants. Exposed via `/api/redespacho/today` (our units) and `/api/redespacho/national` (all plants for ticker). Persists to `dashboard.redespacho_programado` with change detection and audit log in `dashboard.redespacho_historico`. `useXmDispatch()` fetches this every 5 min.
4. **Despacho final (email + XM fallback)**: `EmailDispatchService` reads redespacho notification emails via Microsoft Graph API from a shared mailbox, parses MW values per unit/period, and stores them in `dashboard.despacho_final`. At minute 55, fills missing periods with XM `GeneProgRedesp` as fallback. Runs every 5 min. Email filter starts at 01:00 UTC (8 PM Colombia previous day) to capture early-period emails.
5. **Real-time PME data**: `useRealtimeData()` hook connects to `/ws` (proxied to `ws://localhost:3001`). The server scrapes live kW values from Gecelca's PME diagram via Playwright, converts to MW, and broadcasts via WebSocket. The `EnergyAccumulator` integrates readings into MWh per period. Dashboard gauges and unit cards update in real time; falls back to simulated data when the server is offline.
6. **National redespacho ticker**: `useXmGeneration()` hook fetches `/api/redespacho/national` (all plants from rDEC file). Shows Top 10 plants sorted by current-hour MW. Uses full plant names from the rDEC file, mapped via `Nombre_unidades_y_su_código.json`. Falls back to simulated data on error, marked with "SIMULADO" badge.
7. **Plant name mapping**: `Nombre_unidades_y_su_código.json` maps XM plant codes (`codsic_planta`) to human-readable names (`recurso_ofei`). Used by both `src/data/plantNames.js` (frontend fallback) and `server/redespachoscraper.js` (national ticker). Plant name normalization: uppercase, remove spaces, for matching.

### REST Endpoints

All served by `server/server.js` on port 3001:

| Endpoint | Method | Description | Response format |
|---|---|---|---|
| `/health` | GET | Health check | `{ status, clients }` |
| `/api/periods/today` | GET | Completed hourly energy periods | `[{ unit_id, hora, energia_mwh }]` |
| `/api/despacho-final/today` | GET | Despacho final from EmailDispatchService state | `{ GEC3: { 1: {valor_mw, source}, ... }, GEC32: {...} }` (object keyed by unit then period) |
| `/api/despacho/today` | GET | Despacho programado from dDEC scraper | `{ GEC3: [24 MW], GEC32: [24], TGJ1: [24], TGJ2: [24] }` |
| `/api/redespacho/today` | GET | Redespacho programado from rDEC scraper (our units) | `{ GEC3: [24 MW], GEC32: [24], TGJ1: [24], TGJ2: [24] }` |
| `/api/redespacho/national` | GET | All national plants from rDEC file (for ticker) | `[{ code, name, values: [24 MW] }]` |

### Vite Dev Proxies

Vite dev server (configured in `vite.config.js`) proxies these paths to `http://localhost:3001`:
- `/api/xm/*` → `https://servapibi.xm.com.co` (XM API, with path rewrite)
- `/ws` → WebSocket upgrade
- `/api/periods/*`
- `/api/despacho-final/*` — **Must be listed BEFORE `/api/despacho`** to avoid prefix conflict
- `/api/despacho/*`
- `/api/redespacho/*`

### PME WebSocket Server

`server/server.js` runs a Node.js HTTP + WebSocket server on port 3001. It orchestrates five backend services:
1. **PME Scraper** — Uses Playwright to scrape live kW values from Gecelca's PME web diagram, observes DOM mutations, broadcasts `{ type: "update", units: [...] }` messages enriched with accumulation data, completed periods, minute averages, and despacho final.
2. **Energy Accumulator** — Integrates MW readings over time to compute MWh per hourly period, persists to MSSQL for restart recovery.
3. **Email Dispatch** — Reads redespacho emails via Graph API, stores despacho final values, falls back to XM API at minute 55.
4. **Redespacho Scraper** — Downloads and parses `rDECMMDD.txt` from XM portal every 5 minutes. Also parses all national plants for ticker.
5. **Despacho Scraper** — Downloads and parses `dDECMMDD_TIES.txt` from XM portal. Retries every 5 min until found, then stops for the day.

The dashboard nav shows connection status (En vivo / Reconectando / Conectando). The server is optional — the dashboard works without it using simulated data.

### Database

MSSQL database (`dashboard_gen` by default). Six tables in `dashboard` schema:

| Table | Purpose |
|---|---|
| `generacion_periodos` | Completed hourly energy periods (unit, date, hour, MWh) |
| `generacion_acumulado` | Live accumulation checkpoint per unit (for restart recovery) |
| `despacho_final` | Dispatch final values per unit/period, sourced from email or `xm_fallback`. Constraint: `source IN ('email', 'xm_fallback')` |
| `despacho_programado` | Despacho from dDEC file — INSERT only, one write per unit/date/period |
| `redespacho_programado` | Redespacho from rDEC file — UPSERT, tracks current `version` per record |
| `redespacho_historico` | Audit log of redespacho changes — one row per detected change with `valor_mw_prev` and `valor_mw_new` |

Key design decisions:
- Zero MW is valid data (e.g., Guajira 1 not dispatched). Save functions use `if (valor == null) continue`, NOT `if (valor === 0) continue`.
- `saveRedespachoProgBulk` detects changes with threshold `Math.abs(existing - new) > 0.01` and logs to `redespacho_historico`.
- `saveDespachoProgBulk` is INSERT-only (ignores existing records).
- Indexed: `IX_redesp_hist_fecha` on `(fecha, unit_id, periodo)` for audit queries.

### Environment Variables

The server reads from `.env` (via `--env-file`):
- `WS_PORT` — WebSocket server port (default 3001)
- `PME_LOGIN_URL`, `PME_DIAGRAM_URL`, `PME_USER`, `PME_PASSWORD` — PME scraper credentials
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT` — MSSQL connection (supports named instances via `DB_HOST=host\instance`)
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX` — Microsoft Graph API for email dispatch
- `HEADLESS` — Set to `false` to run Playwright in headed mode (debug)
- `ALERT_WEBHOOK_URL`, `ALERT_TARGET`, `ALERT_POLL_INTERVAL_SEC`, `ALERT_COOLDOWN_MIN`, `ALERT_THRESH_*` — alerter in-process (D-115). Endpoint `GET /health/detailed` expone snapshot canónico per-service. Runbook completo en `docs/runbooks/observability.md`.

**Important**: GRAPH_* variables must be present in **both** the local `.env` and the deployed server's `/var/www/dashboard-gen/server/.env` for email dispatch to work.

### Production Deployment

Deployed on Ubuntu server at `/var/www/dashboard-gen/`. Uses:
- **Nginx** — Serves static `dist/`, reverse-proxies all `/api/*` and `/ws` to Node.js backend (config: `deploy/nginx.conf` → `/etc/nginx/sites-enabled/dashboard-gen`)
- **systemd** — Manages the WebSocket server process (unit: `deploy/dashboard-ws.service` → `dashboard-ws.service`)
- **`deploy/setup.sh`** — Automated setup: installs deps, builds frontend, configures Nginx + systemd

Standard deploy command:
```bash
cd /var/www/dashboard-gen && git pull && npm run build && cd server && npm ci && sudo systemctl restart dashboard-ws
```

If nginx.conf changed:
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-enabled/dashboard-gen
sudo nginx -t && sudo systemctl reload nginx
```

### Debugging

Useful commands for debugging the backend on the deployed server:

```bash
# Check backend service logs
sudo journalctl -u dashboard-ws -f

# Check if backend is responding
curl -s http://localhost:3001/health

# Inspect despacho final endpoint (returns object, NOT array)
curl -s http://localhost:3001/api/despacho-final/today | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# Check despacho scraper
curl -s http://localhost:3001/api/despacho/today | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# Check redespacho scraper
curl -s http://localhost:3001/api/redespacho/today | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"

# Check national plants (for ticker)
curl -s http://localhost:3001/api/redespacho/national | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.length,'plants');console.log(j.slice(0,3))})"
```

### Design system

Color palette and typography constants are defined in `src/theme.js` as `C` (colors) and `FONT`/`MONO` (font stacks). The theme is dark with green/cyan/blue accents.

## ESLint

- `no-unused-vars` ignores variables starting with uppercase or underscore (`varsIgnorePattern: '^[A-Z_]'`)
- Uses flat config format (`eslint.config.js`)

## Notes

- No test framework is configured.
- No TypeScript — plain JSX only.
- All frontend hooks poll every 5 minutes (300000ms) by default.
- The redespacho scraper refreshes every 5 minutes (server-side). The despacho scraper retries every 5 min until found, then stops.
- The server depends on `mssql`, `playwright`, and `ws` (see `server/package.json`). The frontend has no runtime dependencies beyond React 19.
- **Important**: When adding new `/api/*` endpoints to the backend, remember to add corresponding proxy rules in both `vite.config.js` (dev) and `deploy/nginx.conf` (production), otherwise the endpoint will work in dev but fail in production.
- **Important**: In `vite.config.js`, `/api/despacho-final` must be listed BEFORE `/api/despacho` to avoid prefix matching conflicts.
- Colombia timezone is UTC-5 with no DST. All date/time calculations must account for this. The email dispatch filter uses `T01:00:00Z` (8 PM Colombia previous day) to capture early-period emails.
- XM file scraping uses `api-portalxm.xm.com.co/administracion-archivos/ficheros/mostrar-url` with `nombreBlobContainer=storageportalxm`. The API returns a SAS URL to the blob, which is then fetched for the actual file content.
- The `TOTAL` line in rDEC files is filtered out in `parseAllPlants()` to prevent it from appearing in the Top 10 ticker.
- Plant name normalization for matching: uppercase + remove all spaces (e.g., `"GECELCA 3"` → `"GECELCA3"`).
- **Negative PME clamping**: PME readings can have negative spikes that propagate into the energy accumulator and projection. The frontend clamps display values to `>=0` for consistency: `final_` (generación) in `Table.jsx`, `proyGeneracion` (P. Generación) in `Table.jsx`, and the live `deviation` is recomputed in both `Table.jsx` (current period) and `UnitCards.jsx` using `Math.max(0, projection)` against `redespacho` (formula: `((clampedProj - redespacho) / redespacho) * 100`). `UnitCards` receives `xmDispatch` from `Dashboard.jsx` to access the current-period redespacho.

## Cómo evolucionar este archivo

**Agregá una entrada SOLO cuando:**
- Tomaste una decisión arquitectónica no-obvia (qué + por qué, máximo 3 líneas).
- Encontraste un gotcha que va a morder a alguien en el futuro (ej. orden de proxies en `vite.config.js`, `despacho-final` antes de `despacho`).
- Cambió un contrato externo (endpoint, schema BD, env var, formato de archivo XM, contrato WS).
- Cambió un invariante del dominio (nueva unidad, nuevo source para extractor, nueva tabla).

**NO agreges:**
- Qué hace el código (eso ya lo dice el código bien nombrado).
- Cambios pequeños (refactor, rename, bugfix puntual) — `git log` es suficiente.
- Decisiones grandes — esas van a `docs/decisions.md` con formato ADR-lite y acá solo resumen + link.
- Transcripciones de discusiones.

**Reglas de tamaño:**
- 1-3 frases por entrada acá; detalle a `docs/`.
- Si este archivo supera ~400 líneas, mover secciones largas (e.g. tablas de endpoints, env vars, comandos debug) a `docs/architecture.md` y dejar resumen + link.

**Para decisiones grandes**: `docs/decisions.md` con formato ADR-lite (Contexto / Decisión / Consecuencias, 4-8 líneas). Numerá la decisión (D-1NN siguiendo la secuencia).

---

## graphify

This project has a graphify knowledge graph at graphify-out/ (209 nodes, 271 edges, 30 communities). **Nota:** generado pre-migración a medidores ION8650; las god nodes y comunidades pueden estar parcialmente obsoletas. Tratar como referencia, no fuente de verdad.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
- Open graphify-out/graph.html in a browser for interactive visual exploration

### God Nodes (most connected abstractions)

1. `getDB()` — 22 edges (central to all persistence)
2. `EmailDispatchService` — 11 edges
3. `PMEScraper` — 10 edges
4. `PME Balance de Potencia Diagram` — 10 edges
5. `EnergyAccumulator` — 9 edges
6. `Unit Selection Cards Bar` — 9 edges
7. `scrapeDespacho()` / `scrapeRedespacho()` — 7 edges each
8. `RedespachoscraperService` — 7 edges

### Key Communities

| Community | Cohesion | Key Nodes |
|---|---|---|
| Database Layer | 0.17 | getDB(), save/get functions (22 nodes) |
| UI Components & Metrics | 0.17 | Chart.jsx, MiniGauge, UnitCards, theme (19 nodes) |
| Redespacho Scraper | 0.20 | parseAllPlants(), downloadFile(), RedespachoscraperService (10 nodes) |
| PME & Brand Assets | 0.13 | Logos, PWA config, PME diagram (18 nodes) |
| Email Dispatch Service | 0.22 | EmailDispatchService, fetchXmRedespacho(), getGraphToken() (5 nodes) |
| Data Flow Documentation | 0.16 | Architecture docs, timezone, clamping rationale (16 nodes) |
| Despacho Scraper | 0.23 | DespachoscraperService, parseItems(), downloadFile() (9 nodes) |
| Architecture Documentation | 0.15 | SPA arch, backend layer, MSSQL schema, deployment (13 nodes) |
| Server Core | 0.47 | broadcast(), colombiaNow(), getMergedDespachoFinal() |
| Projection Calculator | 0.67 | colombiaSecondsInHour(), computeLive() |

### Hyperedges (cross-cutting group relationships)

- **Five Backend Services Orchestrated by server.js** — PME scraper, energy accumulator, despacho final, redespacho, despacho programado
- **Data Flow Pipeline (XM Files → Frontend)** — XM file scraping → despacho/redespacho parsing → database → REST endpoints → frontend
- **Generation Units Tracked Across All Sources** — GEC3/GEC32/TGJ1/TGJ2 appear in despacho, redespacho, despacho final, and realtime PME
