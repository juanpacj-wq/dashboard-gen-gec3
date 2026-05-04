# PME Scraper (hot-standby)

**Verifica:** el scraper Playwright que loguea a `gpme.gecelca.com.co` y
observa el diagrama de balance está vivo y alimentando valores. Es la fuente
secundaria — sirve cuando los medidores físicos caen.

## Cuándo correrlo

- Si `orchestrator-fuente.md` muestra `source: "pme"` en alguna unidad.
- Tras deploy (especialmente si Playwright/chromium fueron actualizados).
- Si el log muestra `[Scraper] Reintentando en 5s...` sostenido.

## En el server (Ubuntu)

```bash
# Status del PME scraper
curl -s http://localhost:3001/health | jq '.pme.pme'

# Logs recientes del scraper
sudo journalctl -u dashboard-ws --since "10 minutes ago" \
  | grep -E '\[Scraper\]|\[PME\]' | tail -20
```

## En local (PowerShell)

```powershell
(Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing).Content `
  | ConvertFrom-Json `
  | Select-Object -ExpandProperty pme `
  | Select-Object -ExpandProperty pme `
  | Format-List
```

## Esperado

```json
{
  "running": true,
  "warming": false,
  "lastDataAt": "2026-05-04T15:55:12.000Z",
  "secondsSinceUpdate": 2,
  "updateCount": 142,
  "errorCount": 0,
  "stale": false,
  "valueStale": false
}
```

Y en logs:
```
[PME] GUAJIRA 1: 73.0 MW | GUAJIRA 2: 72.5 MW | GECELCA 3: -0.4 MW | GECELCA 32: -4.8 MW · (+21 updates en ventana)
```

## Interpretación

- 🟢 `running: true`, `warming: false`, `secondsSinceUpdate < 30` → scraper sirviendo.
- 🟡 `warming: true` durante el primer minuto post-restart (Playwright tarda en loguear).
- 🟡 `errorCount > 0` pero `stale: false` → tuvo errores transient pero recuperó.
- 🔴 `stale: true` o `secondsSinceUpdate > 60` → scraper congelado o desconectado del PME.
- 🔴 Logs con `[Scraper] Reintentando en 5s` repetido → no logra loguear, posible
  cambio de credenciales en el PME o caída del sitio Gecelca.

## Si falla

```bash
# Verificar que el sitio del PME responde
curl -I https://gpme.gecelca.com.co/web

# Test de credenciales manualmente (verificar PME_USER / PME_PASSWORD en .env)
cat /var/www/dashboard-gen/server/.env | grep ^PME_

# Reiniciar el servicio para reset del navegador headless
sudo systemctl restart dashboard-ws
```

Si tras restart sigue fallando: el sitio Gecelca puede estar caído o las
credenciales rotaron. El sistema sigue funcionando con medidores primarios
(`orchestrator-fuente.md` debe mostrar `source: meter` en las 4).
