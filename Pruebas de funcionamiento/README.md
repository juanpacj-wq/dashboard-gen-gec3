# Pruebas de funcionamiento — Dashboard GEC3

Smoke tests para verificar que el sistema está corriendo correctamente. Pensados
para correr en **<2 minutos por test**, principalmente:

- **Después de cada deploy** en el server Ubuntu (capibara).
- Como **diagnóstico ad-hoc** cuando el dashboard reporta algo raro.

Cada archivo describe **un test específico** con su comando en producción
(SSH al server) y su variante local (PowerShell desde Windows), output esperado,
y cómo interpretar pass/fail.

## Estructura

```
01-Medidores y PME/         meters ION8650 + orchestrator + PME hot-standby
02-Despacho Final (Email)/  Graph API + parser + persistencia DB
03-XM Scrapers/             dDEC (despacho) + rDEC (redespacho)
04-Frontend y Realtime/     WebSocket + hook + badges UI
05-Servicio y Deploy/       systemd + /health + git pull/rollback
99-Diagnostico/              scripts standalone para troubleshoot profundo
```

## Pre-requisitos

**Para tests del server (producción):**
- SSH al host: `ssh jcespedes@capibara` (o equivalente).
- `jq` instalado (para parsear JSON): `sudo apt install jq` si no está.
- Permisos para `sudo systemctl` y `sudo journalctl`.

**Para tests locales (Windows):**
- `dashboard-gen-gec3/.env` con todas las vars (`GRAPH_*`, `DB_*`, `PME_*`).
- Node 20+ instalado.
- Si el test usa `Invoke-WebRequest`, ejecutar en PowerShell, no `cmd`.
- Para tests de DB: server local arrancado (`cd server; npm start`) o uso directo de scripts en `99-Diagnostico/`.

## Smoke pack mínimo post-deploy

Para verificar rápido que un deploy quedó sano, correr en orden:

1. `05-Servicio y Deploy/service-restart.md` — confirmar que el servicio levantó limpio.
2. `05-Servicio y Deploy/health-overview.md` — `status: ok`, sin componentes stale.
3. `01-Medidores y PME/orchestrator-fuente.md` — las 4 unidades en `meter` o `pme`.
4. `02-Despacho Final (Email)/observabilidad-stale.md` — emailDispatch.{gec,tgj}.stale = false.
5. `04-Frontend y Realtime/badges-visuales.md` — abrir dashboard, ver badges.

Si los 5 pasan, el deploy está OK. Si alguno falla, ir a la sección "Si falla"
del archivo correspondiente.

## Convenciones

- 🟢 = comportamiento esperado / pass.
- 🟡 = degradado pero funcionando (ej: PME en lugar de meter).
- 🔴 = falla, requiere investigación.

Los comandos prod asumen estar en el server Ubuntu vía SSH. Los comandos local
asumen estar en `dashboard-gen-gec3/` (raíz del proyecto) en PowerShell.
