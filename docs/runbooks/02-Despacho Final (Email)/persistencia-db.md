# Persistencia de Despacho Final en DB

**Verifica:** los registros parseados de los correos efectivamente llegan a la
tabla `dashboard.despacho_final` con `source = 'email'` (o `'xm_fallback'` para
periodos rellenados al minuto 55), y que los valores coinciden con lo que
muestra la fila "Despacho Final" del dashboard.

## Cuándo correrlo

- Cuando hay sospecha de divergencia entre dashboard y DB.
- Tras un fix relacionado al pipeline de email (validar que persiste OK).
- Antes de un audit del Centro de Despacho que requiera datos confiables.

## En el server (Ubuntu)

```bash
cd /var/www/dashboard-gen/server
node --env-file=../.env scripts/probe-despacho-final.js          # hoy (Bogotá)
node --env-file=../.env scripts/probe-despacho-final.js 2026-05-04  # fecha específica
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
{"unit_id":"GEC3","periodo":1,"valor_mw":0,"source":"email",...}
{"unit_id":"GEC3","periodo":4,"valor_mw":0,"source":"email",...}
...
{"unit_id":"TGJ1","periodo":1,"valor_mw":145,"source":"email",...}
{"unit_id":"TGJ2","periodo":4,"valor_mw":91,"source":"email",...}
...
--- count by unit ---
GEC3 email = 11
GEC32 email = 11
TGJ1 email = 10
TGJ2 email = 10
--- columns ---
  id, unit_id, fecha, periodo, valor_mw, source, email_subject, email_id, email_date,
  created_at, updated_at, created_by
```

## Interpretación

- 🟢 Cada unidad debería tener tantas rows como periodos transcurridos del día,
  menos los que el operador no haya emitido (P2/P3 son comunes faltantes).
- 🟢 `source` debería ser mayoritariamente `email`, ocasionalmente `xm_fallback`
  para los rellenados a minuto 55.
- 🟡 Diferencia de ±1 fila entre GEC y TGJ es normal (el operador puede emitir
  correos con timing distinto).
- 🔴 0 rows para una unidad → email no se está parseando para esa unidad. Ir a
  `email-fetch-y-parse.md`.
- 🔴 Rows pero `valor_mw` siempre 0 para TGJ → el parser está extrayendo el
  número equivocado del body. Comparar con `[Row]` logs.

## Cross-check con la API

```bash
# Server
curl -s http://localhost:3001/api/despacho-final/today \
  | jq '.TGJ1, .TGJ2 | to_entries[] | {p: (.key | tonumber), val: .value.valor_mw, src: .value.source}'
```

Los registros que devuelve este endpoint deberían ser **subconjunto** de lo que
el probe directo a DB ve (la API filtra por `unitIds` por servicio y depende
del `#loadState()` en memoria, que se refresca cada 5 min).

## Si falla

- Si DB tiene rows pero `/api/despacho-final/today` no las devuelve →
  `#loadState()` está stale o falló. Mirar `observabilidad-stale.md`.
- Si DB no tiene rows → el parser/save está roto. Ir a `email-fetch-y-parse.md`.
