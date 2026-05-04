# Conectividad de medidores ION8650

**Verifica:** los 5 medidores físicos (TGJ1, TGJ2, GEC32, GEC3 ×2) responden
HTTP en sus IPs corporativas y `MeterPoller` no acumula errores consecutivos.

## Cuándo correrlo

- Tras cada deploy.
- Si el dashboard muestra alguna card en badge "PME" ámbar (indica fallback).
- Si en `journalctl` aparecen `MeterTimeoutError` o `MeterAuthError` sostenidos.

## En el server (Ubuntu)

```bash
curl -s http://localhost:3001/health \
  | jq '.pme.meter.perMeter | to_entries[] | {key, errors: .value.consecutiveErrors, lastErr: .value.lastError}'
```

## En local (PowerShell)

```powershell
(Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing).Content `
  | ConvertFrom-Json `
  | Select-Object -ExpandProperty pme `
  | Select-Object -ExpandProperty meter `
  | Select-Object -ExpandProperty perMeter
```


## Esperado

```json
{ "key": "TGJ1@192.168.3.40",     "errors": 0, "lastErr": null }
{ "key": "TGJ2@192.168.3.42",     "errors": 0, "lastErr": null }
{ "key": "GEC3@192.168.200.5",    "errors": 0, "lastErr": null }
{ "key": "GEC3@192.168.200.6",    "errors": 0, "lastErr": null }
{ "key": "GEC32@192.168.200.2",   "errors": 0, "lastErr": null }
```

## Interpretación

- 🟢 `errors: 0` y `lastErr: null` en los 5 → todo sano.
- 🟡 `errors: 1-2` puntual → blip transient, normal en la red corporativa.
  El orchestrator no switchea a PME hasta llegar a 3 consecutivos.
- 🔴 `errors >= 3` sostenido en uno o más → ese medidor está caído. La unidad
  correspondiente debería estar mostrando badge "PME" en el dashboard.
- 🔴 `errors > 10` creciendo → problema recurrente: cable, firewall, credenciales
  cambiadas, o equipo apagado. Verificar con `ping` desde el server al IP del medidor.

## Si falla

```bash
# Ping directo al medidor reportando errores (ej: TGJ2)
ping -c 3 192.168.3.42

# Probar autenticación HTTP Basic con las credenciales del .env
curl -u "user1:5121" http://192.168.3.42/Operation.html | head -c 500
```

Si el `ping` falla → red. Si el `ping` ok pero `curl` da 401 → password rotó.
Si `curl` da 200 pero el server sigue acumulando errores → bug en `MeterPoller`,
investigar con `99-Diagnostico/probe-meters.md`.
