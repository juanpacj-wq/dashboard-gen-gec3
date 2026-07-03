# Runbook — Observabilidad y alerting (W2)

Cómo diagnosticar y resolver alertas emitidas por el alerter in-process del
server. Ver decisiones de diseño en `../decisions.md` D-115.

> A diferencia de las carpetas `01-Medidores y PME/`, `02-…`, etc. que son
> **smoke tests** post-deploy, este archivo es un **runbook de alerta**:
> qué hacer cuando llega un webhook al canal Teams/Slack/genérico.

## Cómo se ve una alerta

El alerter manda un POST con JSON a `ALERT_WEBHOOK_URL`. El cuerpo depende de
`ALERT_TARGET`:

- `generic` → `{ severity, incident_key, title, body, first_seen_at, emitted_at, source }`
- `teams`   → `MessageCard` con `themeColor` por severidad
- `slack`   → `text + blocks` con emoji

**Severidades:**
- `WARN` — degradación parcial. No emite recovery cuando se resuelve.
- `CRITICAL` — falla operativa. Emite `RECOVERED` cuando se resuelve.
- `RECOVERED` — incidente CRITICAL recuperado.

## Endpoint para diagnóstico

```bash
# Prod (SSH al server Ubuntu):
curl -s http://localhost:3001/health/detailed | jq .

# Local (PowerShell Windows):
Invoke-RestMethod http://localhost:3001/health/detailed | ConvertTo-Json -Depth 6
```

Devuelve estado per-service + per-unit + flags derivados. Mirar primero ahí
cuando llega una alerta — confirma que el problema sigue activo.

## Escenarios (los 7 que el alerter monitorea)

### 1. `meterPoller:{unitId}@{host}` — WARN

**Síntoma:** un medidor ION8650 reporta errores consecutivos (default ≥15
ticks = ~30s).

**Diagnóstico:**
```bash
curl -s http://localhost:3001/health/detailed | jq '.services.orchestrator.meter.perMeter'
```
Buscar el `unitId@host` con `consecutiveErrors > 15`. Mirar `lastError` —
típicamente `EHOSTUNREACH`, `ECONNRESET`, `MeterFormatError`.

**Causas comunes:**
- El meter está apagado o reinició.
- Hay corte en la LAN industrial entre el server y ese meter.
- Firmware del meter cambió y la celda `<td class='v'>` ya no responde el shape
  esperado (`MeterFormatError`). Ver D-113.

**Fix:**
- Reachable? `curl -u <user>:<pass> http://<meter-host>/Operation.html`.
- Si el meter responde pero el dashboard no, reiniciar `dashboard-ws`:
  `sudo systemctl restart dashboard-ws`.
- Si el meter no responde, escalar a OT/automatización.

### 2. `orchestrator:pme:{unitId}` — WARN

> Solo aplica con el fallback PME reactivado (`PME_ENABLED=1`, D-120). Con el flag
> apagado (default) `source` nunca vale `'pme'` y esta alerta no puede disparar.

**Síntoma:** una unidad lleva > `ALERT_THRESH_PME_PERSIST_MIN` (default 10) min
con `source='pme'`.

**Diagnóstico:**
```bash
curl -s http://localhost:3001/health/detailed | jq '.services.orchestrator.perUnit'
```
Confirmar `source: 'pme'` para esa unidad. El badge UI también lo muestra (D-103).

**Causa:** el extractor de medidores falló para esa unidad lo suficiente como
para que el orchestrator switchee a PME (D-102 fallbackThreshold=3). Persistencia
>10 min sugiere que el meter sigue caído.

**Fix:** ir al escenario 1 (revisar meterPoller per-meter) para esa unidad. Una
vez que el meter vuelve, el orchestrator hace recovery a `meter` (D-102
recoveryThreshold=2 OK consecutivos).

### 3. `orchestrator:pme:GLOBAL` — CRITICAL (con recovery)

> Solo aplica con `PME_ENABLED=1` (D-120). Con el fallback apagado, el CRITICAL
> global equivalente es `orchestrator:meterDown:GLOBAL` (escenario 3b).

**Síntoma:** TODAS las unidades en PME simultáneamente durante >
`ALERT_THRESH_PME_GLOBAL_MIN` (default 2) min.

**Causa:** la LAN de medidores cayó. O el server perdió ruta a todos los meter
hosts a la vez.

**Fix:**
- `ping` a cada meter host desde el server.
- Si ninguno responde, escalar a infra (es un problema de red, no de Dashboard).
- El dashboard sigue funcionando con datos PME mientras dura — operativo
  transparente al usuario (badge UI lo marca per-unit).

**Recovery:** cuando ≥ 1 unidad vuelve a `meter` ≥ 1 ciclo de polling del
alerter, sale un `RECOVERED`.

### 3b. `orchestrator:meterDown:GLOBAL` — CRITICAL (con recovery, D-120)

**Síntoma:** con el fallback PME deshabilitado (default), TODAS las unidades llevan
≥ `ALERT_THRESH_METER_DOWN_GLOBAL_MIN` (default 2) min con el medidor caído y sin
carry-forward activo (`holding=false`). En la práctica dispara al primer tick del
alerter tras agotarse el hold TTL (~3 min): las 4 unidades están emitiendo `null`.

**Causa:** la LAN de medidores cayó, o el server perdió ruta a todos los meter hosts
a la vez. A diferencia del escenario 3, acá NO hay fuente secundaria: el dashboard
muestra las unidades sin dato.

**Fix:**
- `ping` a cada meter host desde el server; revisar `conectividad-medidores.md`.
- Si ninguno responde, escalar a infra (problema de red, no de Dashboard).
- Paliativo mientras se repara la LAN (si el PME sí tiene datos): reactivar el
  fallback con `PME_ENABLED=1` (ver `01-Medidores y PME/reactivar-pme.md`).

**Recovery:** cuando ≥ 1 unidad vuelve a tener lectura del medidor, sale `RECOVERED`.

### 4. `emailDispatch:GEC` / `emailDispatch:TGJ` — WARN

**Síntoma:** servicio de email lleva > `ALERT_THRESH_EMAIL_STALE_MIN` (default
20) min sin lectura exitosa.

**Diagnóstico:**
```bash
curl -s http://localhost:3001/health/detailed | jq '.services.emailDispatchGEC'
```
Mirar `lastLoadError`. Típicamente:
- `401 Unauthorized` → token de Graph expirado / credenciales rotaron.
- `Mailbox not found` → cambió `GRAPH_MAILBOX`.
- Sin red al `graph.microsoft.com` (firewall / proxy).

**Fix:**
- Verificar `GRAPH_*` env vars en `/var/www/dashboard-gen/server/.env`.
- `sudo systemctl restart dashboard-ws`.
- Si persiste, escalar a admin del tenant M365.

**Nota:** el fallback XM al minuto 55 (D-110) sigue corriendo igual. El despacho
final se cubre vía XM aunque el email esté caído — pero perdemos trazabilidad
por mailbox.

### 5. `redespachoScraper:stale` — WARN

**Síntoma:** redespacho scraper > `ALERT_THRESH_REDESP_STALE_MIN` (default 30)
min sin descarga exitosa del `rDECMMDD.txt`.

**Diagnóstico:**
```bash
curl -s http://localhost:3001/health/detailed | jq '.services.redespachoScraper'
```
Mirar `lastError`. Causas comunes: SAS URL del portal XM expirada (transitorio
— XM la regenera), red caída, archivo no publicado para hoy todavía
(`lastError: 'file-not-yet-published'`).

**Fix:**
- Hacer una descarga manual para confirmar: ver `server/redespachoscraper.js`
  función `downloadFile()`.
- Si el archivo simplemente no está, esperar 5 min al siguiente ciclo.
- Si la URL responde 5xx persistente, escalar a XM.

### 6. `despachoScraper:stale` — WARN (con ventana horaria)

**Síntoma:** despacho scraper sin archivo después de las 15:00 Bogotá
(`ALERT_DESPACHO_AFTER_HOUR_BOG=15`).

**Por qué la ventana horaria:** el dDEC se publica entre 11:00 y 14:00 Bogotá
normalmente. "No encontrado todavía" antes de las 15:00 es comportamiento
esperado. Después de las 15:00 sin archivo = problema.

**Diagnóstico:**
```bash
curl -s http://localhost:3001/health/detailed | jq '.services.despachoScraper'
# foundForToday: false → no descargó hoy.
# lastError: 'file-not-yet-published' o cualquier otro.
```

**Fix:**
- Verificar manualmente si el archivo está publicado para hoy en el portal XM.
- Si está publicado pero el scraper no lo ve → bug del scraper. Revisar logs
  `sudo journalctl -u dashboard-ws -f`.
- Si no está publicado → XM tarda. Llamar a XM si pasa de las 18:00 sin archivo.

### 7. `accumulator:stale` — CRITICAL (con recovery)

**Síntoma:** acumulador sin `update()` por > `ALERT_THRESH_ACCUMULATOR_STALE_MIN`
(default 5) min.

**Causa:** el extractor está enviando ticks pero el accumulator no integra. O
el extractor cayó completo (sería también el escenario 3 disparado en paralelo).

**Fix:**
- Verificar que el WebSocket sigue broadcasteando: `curl http://localhost:3001/health`
  → `clients` count > 0 + estado scraper `stale: false`.
- Si el scraper está vivo pero el accumulator no, escalar — es bug, revisar
  logs.
- Quick fix: `sudo systemctl restart dashboard-ws`.

## Cómo silenciar / calibrar umbrales

Editar `/var/www/dashboard-gen/server/.env` con las env vars `ALERT_THRESH_*` y
reiniciar `dashboard-ws`. Defaults documentados en `.env.example` del repo.

Para silenciar temporalmente todo el alerting (e.g. mantenimiento):
```bash
# Vaciar webhook URL en .env y reiniciar
sed -i 's|^ALERT_WEBHOOK_URL=.*|ALERT_WEBHOOK_URL=|' /var/www/dashboard-gen/server/.env
sudo systemctl restart dashboard-ws
```

El alerter sigue evaluando pero NO manda webhook — perfecto para mantenimiento
sin perder los logs.
