# D-120 — Contexto base (compartido por todas las etapas)

> Este archivo es el **bloque de contexto acumulado** que cada prompt de etapa referencia.
> Es **inmutable** una vez cerrada la fase de planificación: si algo cambia durante la
> ejecución, se registra en `ESTADO.md` (desviaciones), no acá.
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md` (estado vivo de avance).
> Repo: `dashboard-gen-gec3/` (git independiente; React 19 + Node WS backend puerto 3001 + MSSQL).

## Objetivo

Deshabilitar el fallback PME (PMEScraper: Playwright + Chromium headless con login y
scraping del diagrama PME — el proceso que más recursos consume en el servidor) mediante un
flag **`PME_ENABLED` con default APAGADO**. Con el flag apagado: cero login, cero navegador,
cero scraping, cero conmutación meter↔pme; la extracción de potencia queda solo con
`MeterPoller` (Modbus TCP, D-118). El código PME se **conserva** (no se borra): `PME_ENABLED=1`
explícito restaura el comportamiento actual bit a bit.

**Fuera de alcance:** `deploy/` (Playwright/Chromium se siguen instalando), `src/` (frontend,
el badge MEDIDOR/PME queda tal cual), `fabric-meter-sink/` (no depende de PME), y el borrado
del código PMEScraper. No toca contratos cross-repo.

## Fuentes / insumos

- Decisiones congeladas: `PREGUNTAS-D-120.md` (mismo directorio).
- ADRs relacionados en `docs/decisions.md`: **D-116** (carry-forward con TTL, reemplazo del
  fallback por conteo), **D-118** (Modbus TCP primaria vía `METER_PROTOCOL`), D-101/D-102/D-103
  (arquitectura orquestador/source/badge).
- Estado de producción: ambas instancias (GEC3 y Guajira) corren `METER_PROTOCOL=modbus`
  estables según criterios de `docs/runbooks/01-Medidores y PME/cutover-modbus.md`.

## Destino en BD (lo que ya existe)

No se toca BD. El flujo es solo runtime del extractor (config + orquestador + alertas).

## Endpoints existentes (lo que ya existe)

- `GET /health` — `server/server.js:148-162`: expone `pme = scraper.getStatus()` (es el
  getStatus del **orquestador**, no del scraper) y calcula `degraded` con el `stale`/`valueStale`
  **top-level** (basado en `lastDataAt` del merge) — no depende del sub-scraper PME.
- `GET /health/detailed` — `server/server.js:131-145` vía `buildHealthSnapshot`.
- WS handshake — `server/server.js:350-371`: usa `getStatus()` top-level para `stale`/`staleSeconds`.
- WS broadcast — payload `units[]` incluye `source` y `holding` por unidad
  (`server/extractorOrchestrator.js:311`).

## Patrones de infraestructura a reutilizar

- **Inyección de constructores en el orquestador**: `pmeScraperCtor` / `meterPollerCtor`
  (`server/extractorOrchestrator.js:44-45`) — los tests fabrican sub-extractores fake así.
- **Flags env `=== '1'`**: `CONFIG_SKIP_VALIDATION` (`server/config.js:115`), `PME_DIAGNOSE`
  (`server/scraper.js`). `PME_ENABLED` sigue el mismo patrón.
- **Validación fail-fast al cargar config**: `server/config.js:112-136` (lista `missing`,
  saltable con `CONFIG_SKIP_VALIDATION=1`).
- **Alertas con incidentKey + open/close + cooldown**: `server/alerter.js` — per-unit
  `orchestrator:pme:${u}` (:119-136), global `orchestrator:pme:GLOBAL` (:154-167), per-unit
  `orchestrator:meterDown:${u}` (:141-150). La CRITICAL global nueva replica ese patrón.
- **Tests**: vitest serial (`server/package.json:17` — `vitest run --pool=forks
  --poolOptions.forks.singleFork=true`); correr con `cd server && npm test`. Para probar
  config (valida al cargar el módulo) usar `vi.stubEnv` + `vi.resetModules` + `await import()`.
- **Logs del orquestador**: helper `log(level, msg)` local del módulo.

## Diseño D-120 (acordado)

> Volcado de las decisiones cerradas en `PREGUNTAS-D-120.md`, en forma técnica accionable.

### Schema nuevo / cambios de BD
Ninguno.

### Lógica núcleo

- **`server/config.js`**:
  - `export const PME_ENABLED = process.env.PME_ENABLED === '1'` (default apagado), junto al
    bloque `PME` (:9-14), que se conserva intacto.
  - Validación (:126): `PME_PASSWORD` obligatoria **solo** con `PME_ENABLED` true.
  - `unit()` (:86-88): exige `pme.referencia` solo con flag on; sin `pme` retorna `pme: null`
    (:97). Las 4 unidades conservan su `pme` hardcodeado (rollback).
  - `METER_DEFAULTS.protocol` (:27): default pasa de `'http'` a `'modbus'`; actualizar el
    comentario (:23-26) que dice "el PME sigue siendo fallback en ambos casos".
- **`server/extractorOrchestrator.js`**:
  - Nuevo param del constructor `pmeEnabled = true` (default **true** = retrocompat total con
    los ~98 asserts existentes; el default OFF vive en config, no en la clase).
  - Guardia (:53-55) pasa a `if (pmeEnabled && !pme) throw TypeError(...)`.
  - Con flag off: `#pmeScraper = null` (no se instancia ni se llama `unitsForPME()`); guards
    `if (this.#pmeScraper)` en `start()` (:116-120) y `stop()`.
  - `#tick`: `const pmeValid = this.#pmeEnabled ? isValid(pme, now) : false`. Con eso la rama
    de conmutación a pme (:277-289) queda inalcanzable, el `source` queda sticky en
    `'meter'`/`null` y `valueMW` cae a `null` tras el TTL (:307-309); el log existente
    `HOLD end — reason=TTL→null` (:300) ya cubre el episodio. `source` **nunca** vale `'pme'`.
  - `getStatus()`: agrega `pmeEnabled` top-level y `pme: null` cuando está off.
  - `start()` loguea el modo (`pmeEnabled=...`).
- **`server/server.js`**: pasa `pmeEnabled: PME_ENABLED` al orquestador (:611-617) + log de
  arranque "Fallback PME: DESHABILITADO (PME_ENABLED=1 para reactivar)" / "HABILITADO";
  actualizar el comentario del fallback (:594-600). `/health` y WS handshake no cambian
  (usan el `stale` top-level).
- **`server/scripts/smoke-orchestrator.js`**: pasa el flag igual que server.js (hoy exige
  `PME` de config y arrancaría el scraper).
- **`server/alerter.js`**:
  - Nueva env `ALERT_THRESH_METER_DOWN_GLOBAL_MIN` (default 2) en `DEFAULTS` (:5-20).
  - Nueva alerta `orchestrator:meterDown:GLOBAL` (CRITICAL, con recovery), evaluada junto al
    bloque global existente (:153-167), **gated por `orch?.pmeEnabled === false`** (estricto:
    snapshots legacy sin el campo no cambian de comportamiento):
    `unitIds.length > 0 && unitIds.every(u => !perUnit[u].holding && (perUnit[u].meterDownSeconds ?? 0) >= N*60)`.
    El `!holding` evita el falso positivo durante el carry-forward → dispara justo al agotarse
    el TTL. `meterDownSince` del orquestador ya corre durante el hold (reloj veraz, D-116):
    no se necesita reloj propio tipo `#pmeGlobalSince`.
  - La alerta `orchestrator:pme:GLOBAL` existente se auto-desactiva con flag off (con `source`
    nunca `'pme'`, `allInPme` siempre es false → rama close). No se toca.

### Módulos nuevos
Solo `server/__tests__/config.test.js`. Ningún módulo de producto nuevo.

### Endpoints nuevos / cambios
Ninguno. `/health` pasa a mostrar `pme: null` anidado dentro del status del orquestador con
flag off (campo informativo; `degraded` no depende de él).

### Front
No se toca. El badge MEDIDOR/PME (`src/components/UnitCards.jsx:13-18`) nunca recibirá
`source='pme'` con el flag apagado.

## Semántica congelada del `#tick` con flag off

| Situación | `source` | `holding` | `valueMW` |
|---|---|---|---|
| Meter válido | `'meter'` | false | lectura |
| Meter caído, TTL vivo | `'meter'` | true | `lastGoodMeter.value` |
| Meter caído, TTL agotado | `'meter'` (sticky) | false | `null` |
| Arranque sin lectura válida nunca | `null` | false | `null` |

## Convenciones a respetar

- Tests backend: vitest serial (`cd server && npm test`); no degradar el baseline (todo verde).
- Frontend no se toca → no aplica `npm run build` (si una etapa lo tocara, sería desviación).
- Commits convencionales en español, 1 atomicidad por commit, body con el porqué (HEREDOC).
- El camino `PME_ENABLED=1` debe quedar **bit a bit idéntico** al comportamiento actual:
  ningún test existente se modifica salvo adiciones.
- No romper el server si una dependencia externa no responde (try/catch + log).
- Fuera de scope: `deploy/`, `src/`, `fabric-meter-sink/`, borrado de `server/scraper.js`.
- Idioma de todo artefacto y comentario: tuteo colombiano estándar, sin voseo.
- El working tree trae cambios ajenos al flujo (`CLAUDE.md` raíz borrado, `src/CLAUDE.md` y
  `docs/combo-modbus-ion8650.md` sin trackear): **no** incluirlos en los commits de D-120.
