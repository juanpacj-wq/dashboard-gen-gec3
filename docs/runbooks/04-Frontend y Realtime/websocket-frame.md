# WebSocket: shape del frame y reconexión

**Verifica:** el WebSocket en `/ws` está aceptando clientes, broadcasteando
frames cada ~2 segundos con la estructura esperada (units con `source`,
accumulated, completedPeriods, projection, despachoFinal).

## Cuándo correrlo

- Tras deploy (validar contrato del payload).
- Si las cards del dashboard no actualizan los valores en vivo.
- Si M1/M3 (badge MEDIDOR/PME) no aparece o aparece mal.

## En el server (Ubuntu)

```bash
node -e "
import('ws').then(({WebSocket}) => {
  const ws = new WebSocket('ws://localhost:3001/ws');
  ws.on('open', () => console.error('[WS] connected'));
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'update' && m.units) {
      console.log('--- units ---');
      for (const u of m.units) console.log(u.id, '→', 'src:', u.source, '| MW:', u.valueMW?.toFixed(2));
      console.log('--- top-level keys ---');
      console.log(Object.keys(m).sort().join(', '));
      ws.close(); process.exit(0);
    }
  });
  setTimeout(() => { console.error('timeout'); process.exit(2); }, 8000);
});
"
```

## En local (PowerShell)

```powershell
Push-Location "dashboard-gen-gec3\server"
node -e "
import('ws').then(({WebSocket}) => {
  const ws = new WebSocket('ws://localhost:3001/ws');
  ws.on('open', () => console.error('[WS] connected'));
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'update' && m.units) {
      console.log('--- units ---');
      for (const u of m.units) console.log(u.id, '→', 'src:', u.source, '| MW:', u.valueMW?.toFixed(2));
      console.log('--- top-level keys ---');
      console.log(Object.keys(m).sort().join(', '));
      ws.close(); process.exit(0);
    }
  });
  setTimeout(() => { console.error('timeout'); process.exit(2); }, 8000);
});
"
Pop-Location
```

## Esperado

```
[WS] connected
--- units ---
TGJ1 → src: meter | MW: 73.05
TGJ2 → src: meter | MW: 73.60
GEC3 → src: meter | MW: -0.39
GEC32 → src: meter | MW: -4.72
--- top-level keys ---
accumulated, completedPeriods, despachoFinal, minuteAvgs, minuteDeviations, projection, proyeccionPeriodos, timestamp, type, units
```

## Interpretación

- 🟢 Conexión abre (`[WS] connected`) y se recibe un frame con `type: "update"`.
- 🟢 `units[]` tiene 4 elementos con `id`, `label`, `valueMW`, `maxMW`, `source`.
- 🟢 Top-level keys incluyen los enriquecimientos: `accumulated`, `completedPeriods`,
  `despachoFinal`, `projection`, etc.
- 🟡 `units[i].source` es `null` durante el primer minuto post-restart (warming).
- 🔴 `timeout` o `ECONNREFUSED` → server no aceptó WS, revisar
  `05-Servicio y Deploy/service-restart.md`.
- 🔴 Falta `source` en algún unit → el commit `06c5fed` (M1) no se aplicó. Verificar:
  `cd /var/www/dashboard-gen && git log --oneline | grep "expose per-unit source"`

## Test de reconexión

```bash
# Tab 1: dejar el script de arriba pero modificado para mantenerse abierto
node -e "
import('ws').then(({WebSocket}) => {
  let n = 0;
  function connect() {
    const ws = new WebSocket('ws://localhost:3001/ws');
    ws.on('open', () => console.log('[WS] open', new Date().toISOString()));
    ws.on('close', () => { console.log('[WS] closed, reconnecting in 4s'); setTimeout(connect, 4000); });
    ws.on('message', () => { if (++n % 30 === 0) console.log('  ...', n, 'frames'); });
  }
  connect();
});
"

# Tab 2: reiniciar el servicio
sudo systemctl restart dashboard-ws
```

Esperado en Tab 1:
```
[WS] open 2026-...
  ... 30 frames
[WS] closed, reconnecting in 4s   ← cuando reinicia
[WS] open 2026-...                  ← reconectó solo
```

## Si falla

- Si nunca conecta, revisar nginx (`/ws` location proxy a 3001).
- Si conecta pero los frames no traen `units` → server arrancó pero el
  orchestrator no está broadcasteando, ver `01-Medidores y PME/orchestrator-fuente.md`.
