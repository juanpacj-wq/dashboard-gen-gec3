# D-120 — Preguntas y respuestas (congeladas)

> Sesión de planeación 2026-07-02. Estas respuestas son **autoritativas** para toda
> la implementación. Una vez cerradas no se reabren: si algo cambia durante la ejecución,
> es una **desviación** y se documenta en `ESTADO.md` + el commit de la etapa, no acá.

## Ronda 1

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Eliminamos el código PME por completo o lo dejamos apagado tras un flag? (a) Eliminar código: borrar PMEScraper, config PME, ramas `source='pme'`, desinstalar Playwright/Chromium — recomendado; (b) Flag `PME_ENABLED=false`: conservar todo el código sin instanciar el scraper. | **(b) Flag `PME_ENABLED=false`** — el código se conserva; con `PME_ENABLED=1` explícito todo vuelve a funcionar como hoy. |
| 2 | ¿En qué estado está el cutover Modbus en producción? (a) Ambas instancias ya en Modbus estables; (b) Solo GEC3; (c) Ninguna aún. | **(a) Ambas ya en Modbus, estables** — GEC3 y Guajira corren `METER_PROTOCOL=modbus` y cumplen los criterios del runbook de cutover. |
| 3 | ¿Conservamos el cliente HTTP del ION8650 y el toggle `METER_PROTOCOL` como vía de rollback? (a) Conservar toggle con default `modbus` — recomendado; (b) Borrar HTTP y dejar solo Modbus. | **(a) Conservar toggle, default `modbus`** — el cliente HTTP queda como rollback instantáneo (env + restart, sin código). |
| 4 | Sin PME, ¿qué pasa cuando un medidor falla más allá del carry-forward (D-116, 3 min)? (a) Null + alerta (per-unit + nueva CRITICAL global "todas sin medidor") — recomendado; (b) Carry-forward más largo; (c) Solo null sin nuevas alertas. | **(a) Null + alerta** — carry-forward intacto; TTL agotado → `valueMW=null` + alerta meterDown per-unit + nueva CRITICAL global que reemplaza a la de "todas en PME". |

## Ronda 2

| # | Pregunta | Respuesta |
|---|---|---|
| 5 | ¿Default de `PME_ENABLED` cuando la variable no está en el .env? (a) Apagado — recomendado; (b) Encendido. | **(a) Default apagado** — sin tocar los .env de producción, PME queda deshabilitado al desplegar. Reactivar = `PME_ENABLED=1` explícito. |
| 6 | Con PME apagado, ¿qué hacemos con Playwright/Chromium? (a) Import dinámico + no instalar — recomendado; (b) Solo saltar instalación de Chromium; (c) No tocar el deploy. | **(c) No tocar el deploy** — import estático y Chromium instalado quedan; el ahorro real es que el navegador nunca se lanza. |
| 7 | ¿Tocamos el badge de fuente MEDIDOR/PME en el frontend (UnitCards)? (a) No tocar — recomendado; (b) Ocultar el badge. | **(a) No tocar frontend** — con flag off el badge nunca mostrará PME; sigue correcto si alguien reactiva el flag. |

## Detalles operativos confirmados
- El flag es `PME_ENABLED === '1'` (patrón de `CONFIG_SKIP_VALIDATION`/`PME_DIAGNOSE`); cualquier otro valor (incluida la ausencia) = apagado.
- El default apagado aplica a las DOS instancias (GEC3 y Guajira) sin editar sus `.env`.
- `METER_PROTOCOL` pasa a default `'modbus'`; producción ya lo tiene explícito → el cambio de default es inerte allí. La plantilla `.env.example` (que `deploy/setup.sh` copia al provisionar) debe corregirse de `http` a `modbus`.
- Comportamiento terminal sin fallback: `source` nunca vale `'pme'`; tras el TTL la unidad emite `valueMW=null` con `source` sticky (`'meter'` o `null` en arranque frío).
- Umbral de la CRITICAL global: env nueva `ALERT_THRESH_METER_DOWN_GLOBAL_MIN` (default 2 min), independiente de `ALERT_THRESH_PME_GLOBAL_MIN`.
- No se toca `deploy/` ni `src/` (frontend) en ninguna etapa.
