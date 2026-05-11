# `probe-meters.js` — sondeo standalone de medidores

**Para qué:** golpea cada uno de los 5 medidores ION8650 directamente con un
HTTP request, midiendo latencia y devolviendo el kW recibido. Útil para
descubrir credenciales nuevas, paths distintos, o aislar fallas de red sin
pasar por el pipeline del orchestrator.

## Cuándo correrlo

- Cuando `01-Medidores y PME/conectividad-medidores.md` reporta errores y
  necesitás aislar si es problema de red, credencial o software.
- Antes de aplicar cambios al pipeline de medidores (verificar baseline).
- Cuando llega un medidor nuevo o uno cambia de IP/password.

## En el server (Ubuntu)

```bash
cd /var/www/dashboard-gen/server
npm run probe
```

## En local (PowerShell)

```powershell
Push-Location "dashboard-gen-gec3\server"
npm run probe
Pop-Location
```

## Esperado

```
unit  | host                 | kW         | ms    | status
TGJ1  | 192.168.3.40         | 73015.2    | 142   | OK
TGJ2  | 192.168.3.42         | 72734.5    | 156   | OK
GEC32 | 192.168.200.2        | -4877.6    | 89    | OK
GEC3  | 192.168.200.5        | -211.3     | 91    | OK
GEC3  | 192.168.200.6        | -310.7     | 95    | OK
```

(Los valores en kW; `MeterPoller` los pasa a MW dividiendo entre 1000.)

## Interpretación

- 🟢 Las 5 filas con `status: OK` y `ms < 500` → red ✅ y credenciales ✅.
- 🟡 `ms > 1000` en alguno → red lenta para ese host. Aceptable mientras
  esté bajo el `METER_TIMEOUT_MS` (6000ms por default).
- 🔴 `status: TIMEOUT` → ese medidor no responde HTTP. Probar `ping <ip>`.
- 🔴 `status: AUTH_FAIL` → credenciales rotaron. Actualizar `PSW_*` en `.env`.
- 🔴 `status: PARSE_FAIL` → el medidor responde pero el HTML cambió formato.
  Posible firmware update — revisar `meterClient.js` para adaptar el parser.

## Variantes útiles

```bash
# Custom timeout (más permisivo si la red está lenta)
PROBE_TIMEOUT_MS=10000 node scripts/probe-meters.js

# Probe a un solo medidor con credenciales custom (override .env)
METER_TGJ1_HOST=192.168.3.40 METER_TGJ1_USER=otro METER_TGJ1_PASS=otro node scripts/probe-meters.js
```

## Si falla

- Si todas las 5 filas fallan → server no tiene ruta a la red corp.
  Probar `ping 192.168.3.40` y revisar firewall/VPN.
- Si solo 1-2 fallan → equipo apagado, rebooted o IP cambió. Coordinar con
  el equipo de planta para verificar el medidor físicamente.
