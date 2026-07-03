# D-120 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable),
> este archivo se actualiza en CADA etapa:
> - **Al empezar** una etapa: leerlo para saber qué quedó hecho, qué se descubrió y qué
>   desviaciones acumuladas hay.
> - **Al terminar** una etapa: registrar qué se hizo, archivos tocados, resultado de
>   tests, desviaciones y datos descubiertos.
> Una etapa solo se ejecuta si **todas las anteriores figuran ✅** en el tablero.

## Tablero de avance
| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | Carpeta de prompts creada: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-120.md`, `ESTADO.md`, `E1..E4`. |
| E1 — Flag PME_ENABLED en config + default modbus | ✅ | `PME_ENABLED` exportado (default off), validación/`unit()` condicionadas, protocolo default modbus, `.env.example` corregido, 6 tests nuevos. |
| E2 — Gate pmeEnabled en el orquestador | ✅ | Param `pmeEnabled` (default true), scraper no instanciado con flag off, `pmeValid` forzado false, `getStatus()` con `pmeEnabled`/`pme:null`, wiring server.js + smoke, 7 tests nuevos. |
| E3 — CRITICAL global meterDown en alerter | ✅ | `orchestrator:meterDown:GLOBAL` (CRITICAL con recovery) gated por `pmeEnabled === false`, umbral env nuevo (2 min), 7 tests nuevos. |
| E4 — Docs + ADR D-120 + cleanup + cierre | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

## Decisiones / desviaciones acumuladas
> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno
> con la etapa que lo originó y si tiene o no impacto funcional.
- (vacío al arrancar)

## Datos descubiertos en ejecución
> Hechos que solo se conocen corriendo (conectividad, baselines reales, fixtures).
- (vacío al arrancar)

## Bitácora por etapa
### E0 — Andamiaje  ✅
- Creados: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-120.md`, `ESTADO.md`, `E1-config-flag.md`,
  `E2-orchestrator-gate.md`, `E3-alerter-global.md`, `E4-docs-cleanup.md`.
- Branch: `feat/pme-flag-off-2026-07` (desde `feat/multi-instancia-runtime-config`).
- Sin código de producto todavía.

### E1 — Flag PME_ENABLED en config + default modbus  ✅
- **Archivos tocados:** `server/config.js` (export `PME_ENABLED === '1'`; validación de
  `PME_PASSWORD` y exigencia de `pme.referencia` en `unit()` condicionadas al flag; retorno
  `pme: null` si falta; `METER_DEFAULTS.protocol` default `'modbus'`; mensaje de validación
  neutro), `.env.example` (bloque `PME_ENABLED` documentado, `METER_PROTOCOL=modbus`,
  anotaciones "solo con PME_ENABLED=1" en PME_*/HEADLESS/PME_DIAGNOSE, nota obsoleta del
  toggle eliminada), nuevo `server/__tests__/config.test.js` (6 casos con `vi.resetModules`
  + `vi.stubEnv` + import dinámico).
- **Verificación:** `cd server && npm test` → 12 archivos / 135 tests, todo verde.
- **Desviaciones:** ninguna. (Ejecutada en la misma sesión de planeación por directiva del
  usuario vía /goal, no en sesión limpia.)

### E2 — Gate pmeEnabled en el orquestador  ✅
- **Archivos tocados:** `server/extractorOrchestrator.js` (param `pmeEnabled = true`, guardia
  `pmeEnabled && !pme`, `#pmeScraper = null` con flag off sin llamar `unitsForPME()`, guards
  en `start()`/`stop()`, `pmeValid` forzado false en `#tick`, `getStatus()` con `pmeEnabled`
  top-level y `pme: null`, log de arranque con el modo), `server/server.js` (import
  `PME_ENABLED`, `pmeEnabled` al constructor, log "Fallback PME: DESHABILITADO/HABILITADO",
  comentario del extractor actualizado), `server/scripts/smoke-orchestrator.js` (pasa el flag),
  `server/__tests__/extractorOrchestrator.test.js` (describe nuevo `pmeEnabled=false`, 7 casos,
  builder propio sin config pme; batería existente sin cambios).
- **Verificación:** `cd server && npm test` → 12 archivos / 142 tests, todo verde.
- **Desviaciones:** ninguna. El smoke manual con server corriendo queda para el checklist de
  E4 (requiere acceso a los medidores de la red corporativa).

### E3 — CRITICAL global meterDown en alerter  ✅
- **Archivos tocados:** `server/alerter.js` (`ALERT_THRESH_METER_DOWN_GLOBAL_MIN: 2` en
  DEFAULTS; bloque `orchestrator:meterDown:GLOBAL` tras el global PME, gate estricto
  `orch?.pmeEnabled === false`, condición `every(!holding && meterDownSeconds ≥ N*60)`,
  CRITICAL con recovery), `server/__tests__/alerter.test.js` (describe nuevo, 7 casos:
  dispara/holding/legacy/parcial/recovery/cooldown/umbral configurable), `.env.example`
  (umbral documentado + nota "solo con PME_ENABLED=1" en los umbrales PME).
- **Verificación:** `cd server && npm test` → 12 archivos / 149 tests, todo verde.
- **Desviaciones:** ninguna. Dato confirmado: `healthSnapshot.js` pasa el `getStatus()` del
  orquestador completo (`orchestrator: safe(...)`), así que `pmeEnabled` fluye al alerter
  sin cambios en healthSnapshot.

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->
