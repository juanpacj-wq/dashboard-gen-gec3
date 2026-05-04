# `probe-emails.js` — auditoría del mailbox vía Graph API

**Para qué:** consulta Microsoft Graph API directamente con cuatro filtros
progresivamente más permisivos para distinguir entre "los correos no existen
en el mailbox" vs "el filtro del server los está descartando". Útil cuando
hay sospecha de que algún email se parsea mal o no se ve.

## Cuándo correrlo

- Cuando el dashboard muestra "Despacho Final" sin ✉ para periodos donde
  esperabas que sí lo hubiera.
- Cuando el operador del Centro de Despacho dice "envié el redespacho de P3"
  pero el dashboard no lo refleja.
- Para auditar cuántos correos llegaron en un día específico.

## En el server (Ubuntu)

```bash
cd /var/www/dashboard-gen/server
node --env-file=../.env scripts/probe-emails.js              # hoy Bogotá
node --env-file=../.env scripts/probe-emails.js 04/05/2026   # fecha DD/MM/YYYY
```

## En local (PowerShell)

```powershell
Push-Location "dashboard-gen-gec3\server"
node --env-file=../.env scripts/probe-emails.js 04/05/2026
Pop-Location
```

## Qué hace cada filtro

1. **Filtro 1 — exacto del server:**
   `contains(subject,'Redespacho Periodo') and receivedDateTime ge T01:00:00Z`.
   Replica lo que el código de producción usa. Resultado debe coincidir con
   lo que el server vio.

2. **Filtro 2 — sin restricción de fecha:**
   Busca todos los "Redespacho Periodo" en los últimos 200 emails. Útil para
   confirmar que el filtro de fecha no está cortando algo.

3. **Filtro 3a/3b — específico para P2 y P3:**
   Búsqueda directa para los periodos sospechosos. Si retornan 0, esos
   correos no existen.

4. **Filtro 4 — por rango UTC SIN `contains`:**
   Lista todos los correos de un día sin filtro de subject. Caza variantes
   de naming, asuntos distintos, o emails que cualquier filtro `contains`
   se pueda comer silenciosamente.

## Esperado

```
=== Probe emails para fecha 04/05/2026 (ISO 2026-05-04) ===
Mailbox GRAPH_MAILBOX:    ENERGIA@GECELCA.COM.CO
Mailbox GRAPH_MAILBOXTEG: ENERGIA@GECELCA.COM.CO

[1] Filtro exacto del server
    → 32 emails

[2] Subject "Redespacho Periodo" sin restricción de fecha (top 200)
    → 200 totales / 11 con "04/05/2026" en el subject

[3a] Subject "Periodo 2 del" + "04/05/2026"
    → 0 emails

[3b] Subject "Periodo 3 del" + "04/05/2026"
    → 0 emails

[4] TODOS los emails recibidos entre ... (top 500)
    → 47 totales / 34 mencionan "Periodo N"

=== Resumen para 04/05/2026 ===
Periodos CON correo: [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
Periodos SIN correo: [2, 3, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
(11/24 periodos cubiertos)
```

## Interpretación

- 🟢 Filtro 1 y filtro 4 muestran los mismos periodos → el código de
  producción está capturando todo lo que existe.
- 🟡 Filtro 4 muestra periodos que filtro 1 no → bug del filtro del server,
  está descartando emails válidos.
- 🟡 Periodos N y N+1 ausentes en todos los filtros → el operador no envió.
  No es bug del código. Comunicar al Centro de Despacho.
- 🔴 Filtro 4 muestra emails con subject distinto a "Redespacho Periodo"
  (ej: "Programación Periodo 2") → el operador cambió el formato. Adaptar
  el `SUBJECT_RE` en `emailDispatch.js`.
- 🔴 `Variables GRAPH_*` faltantes → ver `02-Despacho Final/email-fetch-y-parse.md`.

## Comparar entre dos días

Útil para validar que el patrón de hoy es típico:

```bash
node --env-file=../.env scripts/probe-emails.js 03/05/2026 2>&1 | grep "Periodos"
node --env-file=../.env scripts/probe-emails.js 04/05/2026 2>&1 | grep "Periodos"
```

Si un día normal tiene 24/24 y el día sospechoso 11/24 con periodos faltantes
no contiguos al final del día → algo raro pasó con el envío del operador.

## Si falla

```bash
# Token Graph no se obtiene
# Verificar GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET en .env

# El client_secret expira cada 24 meses por default en Azure
# Si el script tira "401 invalid_client" o "invalid_grant" → renovar el secret
# en https://portal.azure.com → App Registrations → tu app → Certificates & secrets
```
