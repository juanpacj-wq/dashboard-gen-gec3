# CLAUDE.md — dashboard-gen-gec3

Guía para Claude Code en este repo. Corto a propósito (≤ 250 líneas): el detalle vive en `docs/`.

## Inicio rápido — qué leer

- **Arquitectura** (capas, scrapers, BD, deploy): `docs/architecture.md`.
- **Referencia operativa** (endpoints, variables de entorno, tablas, despliegue, debugging, graphify): `docs/referencia-operativa.md`.
- **Decisiones** (ADR-lite D-101…D-127): `docs/decisions.md`. **Runbooks** por área: `docs/runbooks/`.
- **Despliegue multi-instancia** (`.env.gec3`/`.env.guajira`, `/config.json` en runtime): `docs/deployment-multi-instancia.md` (D-117).
- **Convención de signos** (Gecelca frontera de entrada vs Guajira salida): `server/SIGN_CONVENTION.md`.
- **Mapa del extractor** (meterClient, meterPoller, extractorOrchestrator): `server/EXTRACTION_BACKEND_MAP.md`.
- **Subproyecto Python** (sink a Fabric + PostgreSQL, D-121/D-127): `fabric-meter-sink/CLAUDE.md`.
- **Contrato cross-repo** (consumo de Bit-cora-g3): `../docs/interfaces-cross-repo.md`.
- **Metodología de implementación v2** (olas de lotes en chats paralelos): `../metodología de implementación/README.md`.

## Qué es

Dashboard de generación eléctrica de Gecelca: despacho/redespacho por unidad (GEC3, GEC32, TGJ1, TGJ2),
gráficas de control (CEP), generación en tiempo real desde 5 medidores ION8650 por Modbus TCP, y ticker
con el Top 10 nacional del `rDECMMDD.txt` de XM. Repo git independiente dentro del umbrella
`PORTAL GENERACIÓN/`; `fabric-meter-sink/` vive adentro sin `.git` propio.

## Comandos

- `npm run dev` — Vite (5173) con proxies a 3001/3002. `npm run build` — `dist/`. `npm run lint` — eslint (debe dar 0).
- `cd server && npm run dev` — backend en watch (`.env` de la raíz); `dev:gec3` / `dev:guajira` cargan la instancia. `npm start` — producción.
- `cd server && npm test` — vitest (`--singleFork`), ~1,3 s. `cd fabric-meter-sink && .venv/Scripts/python -m pytest` y `-m ruff check .`.
- Hooks de git versionados: `git config core.hooksPath .githooks` (una vez por clon). Ver `.githooks/README.md`.

## Arquitectura en una pantalla

SPA React 19 + Vite, sin router ni CSS framework (estilos inline). Backend Node HTTP + WebSocket en 3001
que orquesta cinco servicios: extractor de medidores (`ExtractorOrchestrator` + `MeterPoller`, cada 2 s,
**fuente única desde D-126**), `EnergyAccumulator` (MWh por periodo, checkpoint en MSSQL), `EmailDispatchService`
(despacho final por Graph API con fallback XM al minuto 55), `RedespachoscraperService` (rDEC cada 5 min, con
auditoría) y `DespachoscraperService` (dDEC una vez al día). El front funciona sin servidor con datos simulados.

Archivos clave — front: `src/Dashboard.jsx` (layout raíz), `src/hooks/useRealtimeData.js` (WS `/ws` +
`/api/periods/today` + `/api/despacho-final/today`), `useXmDispatch.js`, `useXmGeneration.js`,
`src/components/{Chart,Table,UnitCards,MiniGauge,GenerationTicker}.jsx`, `src/config/paths.js`, `src/theme.js`.
Backend: `server/server.js` (cableado), `extractorOrchestrator.js`, `config.js` (`UNITS`, `METER_DEFAULTS`,
fail-fast), `accumulator.js`, `emailDispatch.js`, `redespachoscraper.js`, `despachoscraper.js`, `db.js`,
`healthSnapshot.js`, `alerter.js`. Dominio compartido: `shared/domain/generation.js` (D-125).

Flujo de datos: dDEC → `despacho_programado` → `/api/despacho/today`; rDEC → `redespacho_programado` (+
`redespacho_historico`) → `/api/redespacho/today|national`; correos → `despacho_final` →
`/api/despacho-final/today`; medidores → WS `{ type: "update", units: [...] }` → acumulador → `generacion_periodos`.

### Sub-path y proxies

El servidor unificado sirve el app bajo `/dashboard/` (nginx quita el prefijo antes de 3001; `eventos-dashboard`
va a Bitácora 3002). `APP_BASE_PATH` gobierna `base` en `vite.config.js` (default raíz `/`), y
`src/config/paths.js` (`apiUrl`, `wsUrl`, `assetUrl`) construye toda URL. En dev Vite sirve en `/` y los
proxies van sin strip: `/api/xm/*` → XM, `/ws` → 3001, `/api/eventos-dashboard` → 3002, `/api/*` → 3001.
`vite.config.js` además sirve `/config.json` desde `deploy/config.<instancia>.json` (`?instance=` / `INSTANCE`).

## Convenciones críticas (no obvias)

1. **Cero MW es dato válido** (Guajira 1 sin despacho): los `save*` usan `if (valor == null) continue`, nunca `=== 0`.
2. **Invariante de generación (D-125)**: generación ≥ 0 y desviación ≥ −100 %, definida **una sola vez** en `shared/domain/generation.js`; el clamp canónico está en `ExtractorOrchestrator.#tick()` y 10 `CHECK` en BD lo hacen imposible de violar. Los helpers son **null-safe a propósito**: `null` es "sin lectura", no cero — un `Math.max(0, null)` apagaría la detección de medidor caído (D-105/D-116). Desviación `NULL` = "sin denominador", se pinta `–`. Runbook: `docs/runbooks/99-Diagnostico/invariante-generacion.md`.
3. **Signo por frontera de medición es dominio físico** y vive en `meterPoller.js` (Gecelca entrada: negativo con la unidad parada es correcto). La invariante de negocio se aplica aguas abajo. No mezclarlos (`server/SIGN_CONVENTION.md`, D-118).
4. **Jerarquía de "Despacho Final" (D-124)**: email > bitácora REDESP > `xm_fallback` > rDEC. `despFinalSource` es procedencia pura; las señales visuales van en `isRedespBitacora`/`hasEmailFinal`.
5. **Fuente única desde D-126**: no existe fallback PME ni navegador. `source` es `'meter' | null`. Los guards de `config.test.js` y `extractorOrchestrator.test.js` fallan si el fallback vuelve por la puerta de atrás. `PME_*` en un `.env` viejo son inertes.
6. **Carry-forward con TTL (D-116)**: ante nulls transitorios del ION8650 la unidad sigue `source='meter'` con el último valor bueno (`holding`) hasta `METER_HOLD_TTL_MIN`; después emite `null`, nunca 0.
7. **Rehidratación de periodos cerrados tras restart**: el mapa `#completed` se repuebla desde `generacion_periodos` al arrancar (antes cada restart dejaba en 0.0 la fila GENERACION de periodos anteriores). El front hace merge REST/WS; verificar "Periodos cerrados rehidratados" en `journalctl` tras cada restart.
8. **Colombia = UTC−5 sin DST** en todo cálculo. El filtro de correos arranca en `T01:00:00Z` (20:00 del día anterior) para capturar los periodos 1 y 2.
9. **XM**: los archivos se bajan por `api-portalxm.xm.com.co/administracion-archivos/ficheros/mostrar-url` (`nombreBlobContainer=storageportalxm`) → SAS URL → blob. La línea `TOTAL` del rDEC se filtra en `parseAllPlants()`. Nombres de planta se normalizan en mayúsculas sin espacios (`"GECELCA 3"` → `"GECELCA3"`).
10. **URLs del front solo con `src/config/paths.js`**, nunca literales `/api` o `/ws`: un solo código sirve raíz y `/dashboard`.
11. **Endpoints nuevos no tocan el proxy** (bloque general `/api/*` en Vite y nginx); solo las excepciones llevan regla. Vite resuelve por prefijo **más largo**, no por orden.
12. **Multi-instancia**: todo cambio en `config.js`/`UNITS`/`.env.example` se verifica arrancando `dev:gec3` y `dev:guajira` (`/health` responde). El `.env` de cada instancia es gitignored; `.env.example` es la única plantilla versionada.
13. **Sink Python (D-121/D-127)** escribe kW **crudos con signo** a Fabric y a PostgreSQL `dl_captura`: es telemetría, no dominio; no aplica la invariante D-125 a propósito.
14. **Sin firmas de IA en commits** y `git commit -- <rutas>` (nunca `add -A`) mientras haya una ola abierta; los hooks de `.githooks/` lo hacen cumplir. Un commit que rompe `npm run lint` o `node --check` no entra.
15. **ESLint**: `no-unused-vars` ignora identificadores que empiezan por mayúscula o `_`; flat config en `eslint.config.js`; `server/**` con globals de Node. Debe estar en 0 errores (baseline 2026-08-26).

## Notas

- Sin TypeScript (JSX plano). Sin framework de tests de front todavía (candidato D-128); el backend usa vitest.
- Los hooks del front refrescan cada 5 min; el rDEC se refresca cada 5 min server-side; el dDEC reintenta cada 5 min hasta encontrar el archivo del día.
- Dependencias del server: `mssql`, `modbus-serial`, `undici`, `cheerio`, `ws`. Front: solo React 19.
- Paleta y tipografía en `src/theme.js` (`C`, `FONT`, `MONO`); tema oscuro con acentos verde/cian/azul.

## Cómo evolucionar este archivo

**Agrega una entrada SOLO cuando:** tomaste una decisión arquitectónica no obvia (qué + por qué, ≤ 3 líneas);
encontraste un gotcha que va a morder; cambió un contrato externo (endpoint, schema, env var, formato XM,
contrato WS); cambió un invariante del dominio. Las convenciones nuevas se numeran a continuación de la
última (el número se **reserva** en la fase de planificación de la implementación) y enlazan su ADR.

**NO agregues:** qué hace el código, cambios pequeños (`git log` basta), decisiones grandes (van a
`docs/decisions.md` con formato ADR-lite y acá solo resumen + link), transcripciones.

**Tamaño:** ≤ 250 líneas. Si crece, mover detalle a `docs/referencia-operativa.md` o `docs/architecture.md`.
