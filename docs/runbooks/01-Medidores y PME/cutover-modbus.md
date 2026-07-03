# Cutover / rollback de extracción Modbus (`METER_PROTOCOL`)

**Qué hace:** cambia la fuente primaria de extracción de los medidores ION8650 entre
HTTP (legacy) y Modbus TCP (D-118), por instancia, con rollback instantáneo. Desde
D-120 `modbus` es el default y el fallback PME está deshabilitado salvo
`PME_ENABLED=1` (ver `reactivar-pme.md`) — el toggle de protocolo es independiente
del flag.

## Antes de empezar (una vez)

1. **Descubrir/confirmar el combo Modbus** (si no está en el `.env`): desde `server/`
   `npm run probe:modbus`. Copiar el `MATCH` (`METER_MODBUS_REGISTER/UNIT_ID/WORD_ORDER/DECODE/SCALE`).
   Combo validado en sombra: `40204 / 1 / high / int32 / 1000`.
2. **Presupuesto de conexiones (≤8 por medidor en :502).** ¿El PME consume slots Modbus
   o habla ION nativo `:7700`? En el host del PME y en cada server Node:
   ```bash
   ss -tn dst :502    # conexiones Modbus por medidor
   ss -tn dst :7700   # ION nativo (lo esperado del PME)
   ```
   Tras migrar: 2 Node × 1 socket + (follow-up) 1 Python = 3 ≪ 8.

## Canary — GEC3 primero (Guajira queda en HTTP como control)

En el server **GEC3** (capibara), editar `/var/www/dashboard-gen/server/.env`:
```bash
METER_PROTOCOL=modbus
METER_MODBUS_PORT=502
METER_MODBUS_UNIT_ID=1
METER_MODBUS_REGISTER=40204
METER_MODBUS_WORD_ORDER=high
METER_MODBUS_DECODE=int32
METER_MODBUS_SCALE=1000
```
```bash
cd /var/www/dashboard-gen && git pull && cd server && npm ci && sudo systemctl restart dashboard-ws
sudo journalctl -u dashboard-ws -n 5 | grep "Extracción primaria"   # debe decir MODBUS
```

## Verificar (24-48 h)

```bash
curl -s http://localhost:3001/health/detailed \
  | jq '.services.orchestrator.perUnit | to_entries[] | {unit:.key, source:.value.source, holding:.value.holding, consecErr:.value.consecMeterErrors}'
curl -s http://localhost:3001/health \
  | jq '.pme.meter.perMeter | to_entries[] | {key, errors:.value.consecutiveErrors}'
```

### Esperado (Modbus sano)
- `source: "meter"` estable en las 4 unidades; `holding: false`.
- `consecutiveErrors` ≈ 0; **menos** nulls/holding/PME que la instancia Guajira (aún HTTP).
- Sin alertas nuevas `orchestrator:meterDown` ni fallback global a PME.

### Interpretación
- 🟢 GEC3 (Modbus) con menos errores/holding que Guajira (HTTP), valores y signos
  coherentes con el control y con el histórico → **promover Guajira** (mismo bloque).
- 🟡 `source: pme`/`holding` recurrente en GEC3 → revisar `conectividad-medidores.md`
  y `ss -tn dst :502`; si Modbus falla, hacer rollback y re-correr `probe:modbus`.

## Rollback (instantáneo, sin código)

```bash
# En el .env de la instancia afectada:
METER_PROTOCOL=http
sudo systemctl restart dashboard-ws
```

## Notas

- Cambiar solo `METER_PROTOCOL`; el resto del pipeline (signos, combine, PME fallback,
  accumulator, proyección, `/health`) es idéntico (D-118).
- `fabric-meter-sink` (Python) sigue en HTTP hasta su follow-up con `pymodbus`.
