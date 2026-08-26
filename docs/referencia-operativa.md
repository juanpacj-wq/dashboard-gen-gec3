# Referencia operativa — endpoints, variables, despliegue, debugging, grafo

Detalle que salió de `src/CLAUDE.md` el 2026-08-26 para dejarlo por debajo de 250 líneas (regla de la
metodología v2). Esto es **referencia**, no convención: si algo de acá cambia, se actualiza acá y el
`CLAUDE.md` solo apunta.

## REST endpoints (`server/server.js`, puerto 3001)

| Endpoint | Método | Descripción | Respuesta |
|---|---|---|---|
| `/health` | GET | Health check | `{ status, clients }` |
| `/health/detailed` | GET | Snapshot canónico per-service + `invariantes` (D-115/D-125) | objeto por servicio |
| `/api/periods/today` | GET | Periodos horarios completados | `[{ unit_id, hora, energia_mwh }]` |
| `/api/despacho-final/today` | GET | Despacho final (email-first, D-124) | `{ GEC3: { 1: {valor_mw, source}, … }, GEC32: {…} }` (objeto, no array) |
| `/api/despacho/today` | GET | Despacho programado (dDEC) | `{ GEC3: [24 MW], GEC32: [24], TGJ1: [24], TGJ2: [24] }` |
| `/api/redespacho/today` | GET | Redespacho programado (rDEC), nuestras unidades | ídem |
| `/api/redespacho/national` | GET | Todas las plantas del rDEC (ticker) | `[{ code, name, values: [24 MW] }]` |
| `/api/eventos-dashboard` | GET | **Servido por Bitácora (3002)**, contrato cross-repo | ver `../../docs/interfaces-cross-repo.md` |

Los endpoints `/api/*` nuevos **no** requieren tocar el proxy: `vite.config.js` (dev) y `deploy/nginx.conf`
(prod) tienen un bloque general `/dashboard/api/*` → 3001 con strip del prefijo. Solo las excepciones
(XM, `eventos-dashboard` → 3002) llevan regla propia.

## Variables de entorno (`.env`, `.env.gec3`, `.env.guajira`; el server las lee con `--env-file`)

- `WS_PORT` — puerto del server (default 3001).
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT` — MSSQL (instancias nombradas via `DB_HOST=host\instance`).
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX` — Microsoft Graph para el despacho final por correo. **Deben estar en el `.env` local y en `/var/www/dashboard-gen/server/.env`.**
- `METER_PROTOCOL` — `modbus` (default desde D-120; Modbus TCP FC03, D-118) o `http` (legacy, rollback). Boundary: `fetchKwTotal()`; `meterClientFactory.js` elige el cliente. Bloque `METER_MODBUS_*` (reg/unitId/wordOrder/decode/scale). Runbook: `runbooks/01-Medidores y PME/cutover-modbus.md`.
- `METER_HOLD_TTL_MIN` — carry-forward del último valor bueno ante nulls transitorios (D-116); tras N min emite null (fuente única desde D-126). Default 3.
- `ALERT_WEBHOOK_URL`, `ALERT_TARGET`, `ALERT_POLL_INTERVAL_SEC`, `ALERT_COOLDOWN_MIN`, `ALERT_THRESH_*` — alerter in-process (D-115/D-116). Runbook: `runbooks/observability.md`.
- `TRACE_DEVIATION` — CSV de unit IDs para `DeviationTracer` (JSONL por tick en `server/traces/`). Vacío = off.
- `APP_BASE_PATH` — sub-path de despliegue (`/dashboard` en el servidor unificado; vacío = raíz). Lo lee `vite.config.js` al construir y `update.sh` desde `server/.env`.
- ~~`PME_*`, `HEADLESS`~~ — retiradas en D-126; si quedan en un `.env` viejo son inertes.

## Base de datos (esquema `dashboard`)

| Tabla | Uso |
|---|---|
| `generacion_periodos` | Periodos horarios completados (unidad, fecha, hora, MWh) |
| `generacion_acumulado` | Checkpoint vivo de acumulación por unidad (recuperación tras restart) |
| `despacho_final` | Valor final por unidad/periodo con `source IN ('email','xm_fallback')` |
| `despacho_programado` | dDEC — INSERT only |
| `redespacho_programado` | rDEC — UPSERT con `version` |
| `redespacho_historico` | Auditoría de cambios de redespacho (`valor_mw_prev`, `valor_mw_new`), índice `IX_redesp_hist_fecha` |
| `proyeccion_periodos`, `proyeccion_historico`, `desviacion_periodos`, `correccion_d125` | Proyección/desviación (D-124/D-125) y rastro del backfill |

Diez `CHECK` constraints (D-125) hacen imposible persistir generación negativa; `/health/detailed`
expone `invariantes.{constraintsAplicadas, constraintsFaltantes, ok}`. Modelo completo: `docs/modelo-datos.md`
(pendiente, ver plan de adopción v2).

## Despliegue (servidor Ubuntu `capibara`, `/var/www/dashboard-gen/`)

- **nginx** sirve `dist/` y proxya `/dashboard/api/*` y `/dashboard/ws` a 3001 (`deploy/nginx.conf` →
  `/etc/nginx/sites-available/dashboard-gen`; el server block incluye las locations de Bitácora).
- **systemd** `dashboard-ws.service` (usuario `www-data`, `EnvironmentFile=server/.env`).
- Actualización: `sudo /var/www/dashboard-gen/deploy/update.sh` (pull ff-only sobre la rama desplegada, build con
  `APP_BASE_PATH` de `server/.env`, `npm ci`, restart). nginx es paso manual:
  `sudo cp deploy/nginx.conf /etc/nginx/sites-available/dashboard-gen && sudo nginx -t && sudo systemctl reload nginx`.
- Instalación desde cero: `APP_BASE_PATH=/dashboard sudo -E ./deploy/setup.sh`.
- Rollback y smoke pack: `runbooks/05-Servicio y Deploy/deploy-rollback.md`. Multi-instancia: `deployment-multi-instancia.md`.
- **Regla (metodología v2):** nada se despliega sin tag `deploy/YYYY-MM-DD` y sin registrar rama + SHA en
  `../../docs/deployment-unificado.md`.

## Debugging en el servidor

```bash
sudo journalctl -u dashboard-ws -f
curl -s http://localhost:3001/health
curl -s http://localhost:3001/health/detailed | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"
curl -s http://localhost:3001/api/despacho-final/today | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"
curl -s http://localhost:3001/api/redespacho/national | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.length,'plants');console.log(j.slice(0,3))})"
```

## graphify (grafo de conocimiento, `graphify-out/`)

Generado **antes** de la migración a medidores ION8650 (209 nodos, 271 aristas, 30 comunidades): las god
nodes (`PMEScraper`, `PME Balance de Potencia Diagram`) y varias comunidades están obsoletas desde D-118/D-126.
Tratarlo como referencia histórica, no como fuente de verdad. Regenerar con
`python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"`
si se vuelve a usar; `graphify-out/GRAPH_REPORT.md` y `graphify-out/graph.html` para explorar.
