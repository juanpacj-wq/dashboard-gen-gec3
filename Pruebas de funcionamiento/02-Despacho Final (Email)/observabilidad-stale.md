# Observabilidad: estado del `EmailDispatchService`

**Verifica:** la red de seguridad anti-stale del `EmailDispatchService`. Si
Graph API se cae o el `#loadState()` falla, el `#state` in-memory queda con
datos viejos. El campo `stale` en `/health` indica cuándo eso pasa, antes de
que el dashboard mienta.

## Cuándo correrlo

- Como check rutinario en el smoke pack post-deploy.
- Si el dashboard muestra valores que no cuadran con la realidad operacional.
- Si `journalctl` reporta errores transient sostenidos de Graph API.

## En el server (Ubuntu)

```bash
curl -s http://localhost:3001/health | jq '.emailDispatch'
```

## En local (PowerShell)

```powershell
(Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing).Content `
  | ConvertFrom-Json `
  | Select-Object -ExpandProperty emailDispatch `
  | ConvertTo-Json -Depth 4
```

## Esperado (estado normal)

```json
{
  "gec": {
    "unitIds": ["GEC3", "GEC32"],
    "mailbox": "ENERGIA@GECELCA.COM.CO",
    "lastLoadAt": "2026-05-04T16:14:11.080Z",
    "lastLoadAgeSec": 21,
    "stale": false,
    "lastLoadError": null,
    "cachedPeriods": { "GEC3": 11, "GEC32": 11 }
  },
  "tgj": {
    "unitIds": ["TGJ1", "TGJ2"],
    "mailbox": "ENERGIA@GECELCA.COM.CO",
    "lastLoadAt": "2026-05-04T16:14:11.133Z",
    "lastLoadAgeSec": 21,
    "stale": false,
    "lastLoadError": null,
    "cachedPeriods": { "TGJ1": 10, "TGJ2": 10 }
  }
}
```

## Interpretación

- 🟢 Para ambos servicios:
  - `stale: false`
  - `lastLoadAgeSec < 300` (refresh cada 5 min)
  - `lastLoadError: null`
  - `cachedPeriods` con counts coherentes (verificar contra `persistencia-db.md`).
- 🟡 `lastLoadAgeSec` entre 300-900 → el ciclo se atrasó (Graph API lento), pero
  el siguiente debería normalizarlo. Watchear 1-2 min.
- 🔴 `stale: true` (= `lastLoadAgeSec > 900`) → el `#loadState()` lleva más de
  15 min sin éxito. **`/health.status` devuelve `degraded`**. Indica que el
  estado en memoria está desactualizado. Causa típica: Graph API caído sostenido
  o DB inalcanzable.
- 🔴 `lastLoadError` no-null → ver el `message` para la causa exacta. Ej:
  `"Cannot read properties of undefined"` indica un row malformado en DB.
- 🔴 `cachedPeriods.TGJ1 = 0` con periodos avanzados del día → ningún correo
  TGJ se procesó. Verificar `GRAPH_MAILBOXTEG` en `.env`.

## Si falla

```bash
# Reset suave
sudo systemctl restart dashboard-ws
sleep 30
curl -s http://localhost:3001/health | jq '.emailDispatch.gec.stale, .emailDispatch.tgj.stale'

# Si tras restart sigue stale → DB o Graph API tiene problema sostenido.
# Verificar conectividad directa:
curl -I https://graph.microsoft.com/v1.0/$metadata    # 200 OK esperado
nc -zv 192.168.17.20 1433                              # MSSQL en su puerto
```

Si Graph responde pero `#loadState()` sigue fallando → el problema es DB.
Si DB responde pero el fetch de Graph falla → revisar el secret de la app
en Azure (puede haber expirado).
