# Orchestrator: fuente activa por unidad (`source`)

**Verifica:** el `ExtractorOrchestrator` está reportando correctamente cuál
extractor (medidor primario vs PME hot-standby) está sirviendo la lectura de
cada unidad, y que ese campo viaja por el WebSocket al frontend.

## Cuándo correrlo

- Tras deploy (smoke pack mínimo).
- Si una card del dashboard muestra "PME" ámbar — para confirmar la causa
  (¿realmente cayó el medidor o es bug del orchestrator?).

## En el server (Ubuntu)

```bash
curl -s http://localhost:3001/health \
  | jq '.pme.perUnit | to_entries[] | {unit: .key, source: .value.source, consecMeterOk: .value.consecMeterOk, consecMeterErrors: .value.consecMeterErrors}'
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
{ "unit": "TGJ1",  "source": "meter", "consecMeterOk": 142, "consecMeterErrors": 0 }
{ "unit": "TGJ2",  "source": "meter", "consecMeterOk": 142, "consecMeterErrors": 0 }
{ "unit": "GEC3",  "source": "meter", "consecMeterOk": 142, "consecMeterErrors": 0 }
{ "unit": "GEC32", "source": "meter", "consecMeterOk": 142, "consecMeterErrors": 0 }
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

- 🟢 `source: "meter"` en las 4 → primario sirviendo, ideal.
- 🟡 `source: "pme"` en alguna → fallback activo. Cruzar con `conectividad-medidores.md`
  para entender qué medidor cayó. El dashboard la muestra con badge "PME" ámbar.
- 🟡 `source: null` → orchestrator todavía warming up (primer minuto post-restart).
- 🔴 Mismatch entre `/health.perUnit.X.source` y `units[i].source` del WS frame
  → bug en el broadcast, revisar `extractorOrchestrator.js:226`.

## Si falla

- Reset blando: `sudo systemctl restart dashboard-ws` y reverificar tras 30s.
- Si una unidad queda permanentemente en `pme`: ese medidor está caído de verdad,
  ir a `conectividad-medidores.md`.
