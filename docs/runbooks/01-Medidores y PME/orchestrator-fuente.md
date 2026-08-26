# Orchestrator: fuente activa por unidad (`source`)

**Verifica:** el `ExtractorOrchestrator` está reportando correctamente el estado de la
lectura de cada unidad, y que ese campo viaja por el WebSocket al frontend.

> **D-126:** la extracción tiene **fuente única** (medidores ION8650 por Modbus TCP). El
> fallback PME se retiró del código, así que `source` solo puede ser `"meter"` o `null`.
> Agotado el carry-forward (D-116), la unidad emite `valueMW=null` — no hay a quién ceder.
>
> La llave `pme` de `/health` es el **nombre histórico** del estado del extractor y se
> conserva a propósito (la usan estos runbooks); ya no implica que exista un scraper PME.

## Cuándo correrlo

- Tras deploy (smoke pack mínimo).
- Si una card del dashboard pierde el badge "MEDIDOR" o queda sin valor — para confirmar
  la causa (¿realmente cayó el medidor o es bug del orchestrator?).

## En el server (Ubuntu)

```bash
curl -s http://localhost:3001/health \
  | jq '.pme.perUnit | to_entries[] | {unit: .key, source: .value.source, holding: .value.holding, meterDownSeconds: .value.meterDownSeconds, consecMeterErrors: .value.consecMeterErrors}'
```

## En local (PowerShell)

```powershell
(Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing).Content `
  | ConvertFrom-Json `
  | Select-Object -ExpandProperty pme `
  | Select-Object -ExpandProperty perUnit `
  | ConvertTo-Json -Depth 4
```

## Esperado (estado normal)

```json
{ "unit": "TGJ1",  "source": "meter", "holding": false, "meterDownSeconds": 0, "consecMeterErrors": 0 }
{ "unit": "TGJ2",  "source": "meter", "holding": false, "meterDownSeconds": 0, "consecMeterErrors": 0 }
{ "unit": "GEC3",  "source": "meter", "holding": false, "meterDownSeconds": 0, "consecMeterErrors": 0 }
{ "unit": "GEC32", "source": "meter", "holding": false, "meterDownSeconds": 0, "consecMeterErrors": 0 }
```

## Verificar que el WS también propaga `source`

```bash
# Server (Ubuntu) — captura un frame WS
node -e "
import('ws').then(({WebSocket}) => {
  const ws = new WebSocket('ws://localhost:3001/ws');
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'update' && m.units) {
      for (const u of m.units) console.log(u.id, '→', u.source, '|', u.valueMW);
      ws.close(); process.exit(0);
    }
  });
});
"
```

(En local, mismo comando desde `dashboard-gen-gec3/server/` que tiene `ws` instalado.)

## Interpretación

- 🟢 `source: "meter"` con `holding: false` en las 4 → medidores sirviendo, ideal.
- 🟡 `holding: true` → carry-forward activo (D-116): el medidor dio null pero el TTL no
  expiró y se está emitiendo el último valor bueno. Transitorio y esperado.
- 🟡 `source: null` → orchestrator todavía warming up (primer minuto post-restart).
- 🔴 `valueMW: null` con `holding: false` y `meterDownSeconds` creciendo → **el medidor está
  caído de verdad** y el TTL ya se agotó. Ir a `conectividad-medidores.md`. Con las 4 así,
  el alerter abre el CRITICAL `orchestrator:meterDown:GLOBAL`.
- 🔴 `source: "pme"` → **imposible desde D-126**. Si aparece, alguien reintrodujo el
  fallback o el binario desplegado es anterior a esa decisión: verificar la versión.
- 🔴 Mismatch entre `/health.pme.perUnit.X.source` y `units[i].source` del WS frame
  → bug en el broadcast, revisar `extractorOrchestrator.js` (`#tick`).

## Si falla

- Reset blando: `sudo systemctl restart dashboard-ws` y reverificar tras 30s.
- Si una unidad queda permanentemente sin lectura: ese medidor está caído de verdad,
  ir a `conectividad-medidores.md`.
