# `probe-despacho-final.js` — dump directo de la tabla `despacho_final`

**Para qué:** consulta directamente `dashboard.despacho_final` en MSSQL para
una fecha dada y muestra cada row con su `valor_mw`, `source` (email vs
xm_fallback), timestamps y email_subject. Bypassea el cache `#state` del
servicio para ver lo que **realmente** hay en DB.

## Cuándo correrlo

- Cuando hay sospecha de divergencia entre lo que muestra el dashboard y lo
  que está persistido (caso "deployed muestra valores que no están en DB").
- Para auditar qué parsearon los `EmailDispatchService` después de un día de
  operación.
- Cuando alguien del equipo pregunta "¿qué redespacho llegó para TGJ1 P5
  hoy?" — la respuesta está acá.

## En el server (Ubuntu)

```bash
cd /var/www/dashboard-gen/server
node --env-file=../.env scripts/probe-despacho-final.js              # hoy
node --env-file=../.env scripts/probe-despacho-final.js 2026-05-04   # fecha específica
```

## En local (PowerShell)

```powershell
Push-Location "dashboard-gen-gec3\server"
node --env-file=../.env scripts/probe-despacho-final.js
Pop-Location
```

## Esperado

```
--- despacho_final rows for 2026-05-04 ---
{"id":1918,"unit_id":"TGJ1","fecha":"2026-05-04","periodo":1,"valor_mw":145,"source":"email","email_subject":"Redespacho Periodo 1 del día 04/05/2026 de GUAJIRA 2, GUAJIRA 1","email_id":"AAMkAD...","email_date":"2026-05-04T04:23:05.000Z","created_at":"2026-05-04T09:32:38.716Z","updated_at":"2026-05-04T10:12:18.773Z","created_by":"system"}
{"id":1924,"unit_id":"TGJ1","fecha":"2026-05-04","periodo":4,"valor_mw":139.97,"source":"email",...}
...
--- count by unit ---
GEC3 email = 11
GEC32 email = 11
TGJ1 email = 10
TGJ2 email = 10
--- columns of dashboard.despacho_final ---
  id, unit_id, fecha, periodo, valor_mw, source, email_subject, email_id, email_date,
  created_at, updated_at, created_by
```

## Interpretación

- 🟢 Counts por unidad coinciden ±1 con lo que muestra el dashboard en la fila
  "Despacho Final".
- 🟢 `source = "email"` mayoritariamente, ocasionalmente `xm_fallback` para
  periodos rellenados al minuto 55.
- 🔴 Counts en 0 para una unidad pero el dashboard muestra valores → DB
  inconsistente con el endpoint REST. Posible bug de `#loadState()` o cache
  stale (ver `02-Despacho Final/observabilidad-stale.md`).
- 🔴 Más de 1 row por (unit_id, periodo) → bug en el `MERGE` de
  `saveDespachoFinal`. Reportar.

## Lectura del email_subject

El `email_subject` contiene la fecha y periodo originales del email parseado.
Si querés rastrear "¿de qué email vino este valor?" — el subject te lo dice.

## Diagnóstico cruzado

Combinarlo con `probe-emails.md` para auditoria completa:
1. `probe-emails.md` → qué emails están en el mailbox.
2. `probe-despacho-final.md` → qué se persistió en DB.

Si el mailbox tiene email para P5 pero DB no tiene row para P5 → el email
no se parseó. Si DB tiene row pero el mailbox no tiene email → el email se
borró post-parse (normal: Outlook puede archivar). El `email_id` en DB sigue
siendo válido como referencia histórica.

## Si falla

```bash
# Errores típicos:
# - "Login failed for user 'user_portalg3'" → password rotó o cuenta bloqueada.
# - "ECONNREFUSED" → MSSQL no responde, network o servicio caído.
# - "Invalid column name X" → schema cambió, actualizar el script.

# Test de conexión básico
nc -zv 192.168.17.20 1433  # Linux
Test-NetConnection 192.168.17.20 -Port 1433  # Windows PowerShell
```
