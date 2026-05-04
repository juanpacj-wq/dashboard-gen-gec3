# `/health` — anatomía completa del endpoint

**Verifica:** un único `curl` que da una visión completa del estado del
servicio. Este es el test "checkpoint" más útil para confirmar de un vistazo
que todo está sano post-deploy.

## Cuándo correrlo

- Como **primer paso del smoke pack** post-deploy.
- Si cualquier otro test falla, este suele dar la pista de dónde mirar.
- En un cron de monitoreo externo (alertar cuando devuelve `status: degraded`).

## En el server (Ubuntu)

```bash
curl -s http://localhost:3001/health | jq '.'
```

## En local (PowerShell)

```powershell
(Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing).Content `
  | ConvertFrom-Json `
  | ConvertTo-Json -Depth 6
```

## Anatomía del payload

```json
{
  "status": "ok",                      // "ok" | "degraded"
  "clients": 2,                         // # de conexiones WS activas
  "uptime": 1234.5,                     // segundos desde el último start
  "pme": {                              // ExtractorOrchestrator + sub-extractores
    "running": true,
    "warming": false,
    "lastDataAt": "...",
    "secondsSinceUpdate": 1,
    "stale": false,
    "valueStale": false,
    "meter": { ... },                   // → ver 01-Medidores/conectividad-medidores.md
    "pme": { ... },                     // → ver 01-Medidores/pme-scraper.md
    "perUnit": { ... }                  // → ver 01-Medidores/orchestrator-fuente.md
  },
  "emailDispatch": {                    // → ver 02-Despacho Final/observabilidad-stale.md
    "gec": { stale, lastLoadAgeSec, cachedPeriods, ... },
    "tgj": { stale, lastLoadAgeSec, cachedPeriods, ... }
  }
}
```

## Checklist rápido (30 segundos)

```bash
curl -s http://localhost:3001/health | jq '
  {
    status,
    uptime: (.uptime | floor),
    clients,
    pme_stale: .pme.stale,
    pme_value_stale: .pme.valueStale,
    pme_secs_since_update: .pme.secondsSinceUpdate,
    email_gec_stale: .emailDispatch.gec.stale,
    email_tgj_stale: .emailDispatch.tgj.stale,
    email_gec_age: .emailDispatch.gec.lastLoadAgeSec,
    email_tgj_age: .emailDispatch.tgj.lastLoadAgeSec,
    perUnit_sources: (.pme.perUnit | to_entries | map({(.key): .value.source}) | add)
  }'
```

**Esperado (sano):**
```json
{
  "status": "ok",
  "uptime": 1234,
  "clients": 1,
  "pme_stale": false,
  "pme_value_stale": false,
  "pme_secs_since_update": 1,
  "email_gec_stale": false,
  "email_tgj_stale": false,
  "email_gec_age": 21,
  "email_tgj_age": 21,
  "perUnit_sources": { "TGJ1": "meter", "TGJ2": "meter", "GEC3": "meter", "GEC32": "meter" }
}
```

## Interpretación

- 🟢 `status: "ok"` y todos los `*_stale: false` → todo sano.
- 🟡 `pme_secs_since_update > 30` con `pme_stale: false` → cerca del threshold,
  watchear 1 min y verificar si recupera.
- 🔴 `status: "degraded"` → uno o más componentes están stale; mirar cuál y
  consultar el archivo correspondiente en las otras carpetas.
- 🔴 `clients: 0` con dashboard supuestamente abierto → el browser no está
  conectando al WS. Revisar nginx config (`/ws` location) y firewall.

## Como sonda externa

Para monitoreo automático:
```bash
# Devuelve 0 si OK, 1 si degraded
curl -s http://localhost:3001/health | jq -e '.status == "ok"' > /dev/null && echo OK || echo DEGRADED
```

Útil para conectar a Nagios, Grafana, o un cron simple que mande alerta por
email/Slack si devuelve DEGRADED.
