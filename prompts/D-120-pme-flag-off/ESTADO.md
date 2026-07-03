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
| E1 — Flag PME_ENABLED en config + default modbus | ⬜ | — |
| E2 — Gate pmeEnabled en el orquestador | ⬜ | — |
| E3 — CRITICAL global meterDown en alerter | ⬜ | — |
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

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->
