# Restart del servicio + journalctl

**Verifica:** el servicio `dashboard-ws` puede reiniciarse limpiamente, levanta
sin errores fatales, y los logs iniciales muestran inicialización correcta de
todos los sub-componentes (DB, accumulator, scrapers, orchestrator).

## Cuándo correrlo

- Tras `git pull` para aplicar cambios.
- Si `health-overview.md` reporta `status: degraded` y un restart suele resetearlo.
- Si chromium se queda colgado (los logs muestran `[Scraper] Reintentando`
  varias veces seguidas sin progreso).

## En el server (Ubuntu)

```bash
# Status actual
sudo systemctl status dashboard-ws

# Restart
sudo systemctl restart dashboard-ws

# Tail de logs primeros 30s (Ctrl+C para salir)
sudo journalctl -u dashboard-ws -f --since "1 minute ago"
```

## En local (PowerShell)

No hay systemd en Windows. El equivalente es:
```powershell
# Tab donde corre `npm start`: Ctrl+C
# Volver a arrancar:
Push-Location "dashboard-gen-gec3\server"
$env:HEADLESS="true"; npm start
# Pop-Location cuando termines
```

## Esperado en los logs (orden de aparición)

Tras el restart, en orden cronológico deberías ver:

```
1. [RedespScraper] Mapa de plantas cargado: 334 entradas
2. [DB] Schema y tablas verificadas
3. [DB] Conexión OK
4. [Accumulator] Estado restaurado: 4 unidades
5. [EmailDispatch:GEC3,GEC32] Estado cargado desde DB
6. [EmailDispatch:TGJ1,TGJ2] Estado cargado desde DB
7. [Server] Proyección cierre precargada: N filas
8. [EmailDispatch:GEC3,GEC32] Servicio iniciado — intervalo 5min
9. [EmailDispatch:TGJ1,TGJ2] Servicio iniciado — intervalo 5min
10. [RedespScraper] Datos de YYYY-MM-DD cargados desde DB
11. [EmailDispatch:GEC3,GEC32] N correos encontrados
12. [EmailDispatch:GEC3,GEC32] N registros guardados desde correos
13. [DespScraper] Archivo encontrado y cargado para YYYY-MM-DD
14. [orchestrator] ExtractorOrchestrator starting — fallbackThreshold=3 ...
15. [meterPoller] MeterPoller starting — 4 units, 5 meters, poll=2000ms
16. [Scraper] Iniciando navegador (headless=true)…
17. [Server] WebSocket en ws://localhost:3001
18. [Server] Health check en http://localhost:3001/health
19. [Scraper] Login OK
20. [Scraper] Diagrama cargado
21. [PME] GUAJIRA 1: ... | GUAJIRA 2: ... | GECELCA 3: ... | GECELCA 32: ...
22. [meterPoller] heartbeat updates=N errors=0 stale=false ...
```

## Interpretación

- 🟢 Las 22 líneas (o muy similares) aparecen en ~30 segundos. WebSocket
  acepta clientes y los heartbeats del meterPoller son `errors=0`.
- 🟡 `stop-sigterm timed out, killing... SIGKILL` al detener procesos chromium
  → es normal. Playwright a veces se cuelga al shutdown. El siguiente arranque
  no se ve afectado.
- 🟡 `Error inicial: Graph API error: 503` → transient de Microsoft, el
  ciclo siguiente debería recuperar. Si persiste, revisar el secret en Azure.
- 🔴 Servicio termina con `code=exited, status=1` y queda `failed`:
  - Mirar logs de `journalctl` arriba del crash.
  - Causa típica: `.env` con variable faltante o sintaxis JS rota.
  - Verificar: `node --check server.js` desde `/var/www/dashboard-gen/server/`.
- 🔴 `EADDRINUSE: address already in use :::3001` → otro proceso quedó vivo.
  ```bash
  sudo fuser -k 3001/tcp
  sudo systemctl restart dashboard-ws
  ```

## Si falla

```bash
# Ver el error exacto del crash
sudo journalctl -u dashboard-ws --since "10 minutes ago" -n 50 | grep -E 'Error|Exception|Caused'

# Verificar sintaxis del archivo principal
cd /var/www/dashboard-gen/server
node --check server.js

# Verificar que .env tiene todas las variables críticas
cat ../.env | grep -E '^(DB_|GRAPH_|PME_|WS_PORT|USER_MEDIDORES|IP_|PSW_)' | wc -l
# Esperado: ~17-20 líneas
```

Si el servicio entra en crash loop, el rollback al commit anterior es la
acción más segura — ver `deploy-rollback.md`.
