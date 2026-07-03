# Combo Modbus ION8650 — valores validados y comandos de shadow

Referencia rápida del "combo" Modbus con el que se leen los medidores Schneider ION8650
por Modbus TCP (D-118, reemplaza el scraping HTTP de `Operation.html`). Estos cinco
parámetros deben estar **todos correctos al mismo tiempo**: si uno falla, la lectura sale
mal sin dar error.

## Valores validados

Descubiertos con `probe:modbus` y confirmados en sombra (3h, ~18.475 lecturas,
2026-06-30): **0.00% null en Modbus** y valor idéntico a la lectura HTTP.

| Parámetro (env)            | Valor                                        | Qué responde                                                                                   |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `METER_MODBUS_REGISTER`   | 40204<br /><br />para la acumulada es 40230 | ¿En cuál casilla/registro está el kW total?                                                  |
| `METER_MODBUS_UNIT_ID`    | 1                                            | ¿Con cuál medidor (slave/unit ID) hablo?                                                      |
| `METER_MODBUS_WORD_ORDER` | high                                         | ¿En qué orden pego las dos palabras de 16 bits del INT32? (high = más significativa primero) |
| `METER_MODBUS_DECODE`     | int32                                        | ¿En qué formato viene? entero con**signo** (entrega los negativos de Gecelca nativos)   |
| `METER_MODBUS_SCALE`      | 1000                                         | ¿Dónde va la coma decimal? (145000 → 145.000 kW → 145 MW)                                   |

> Registro alterno: `40033` guarda lo mismo pero con `SCALE=10`. Por eso registro y
> escala van de la mano. Con `float32`, `SCALE=1`.

## Bloque de `.env` para activar Modbus

```bash
METER_PROTOCOL=modbus
METER_MODBUS_PORT=502
METER_MODBUS_UNIT_ID=1
METER_MODBUS_REGISTER=40204
METER_MODBUS_WORD_ORDER=high
METER_MODBUS_DECODE=int32
METER_MODBUS_SCALE=1000
```

Rollback instantáneo (sin código): `METER_PROTOCOL=http` + `sudo systemctl restart dashboard-ws`.

## Comandos de validación (correr desde `server/`)

### 1. Descubrir / confirmar el combo

```bash
npm run probe:modbus
```

Prueba la matriz registro × wordOrder × decode contra una lectura HTTP simultánea del
mismo medidor e imprime el `MATCH` con las env vars. Sale 0 solo si los 5 medidores matchean.

### 2. Correr la sombra (compara HTTP vs Modbus en paralelo, auto-stop a las 3h)

```bash
npm run shadow:modbus
```

Escribe JSONL a `server/traces/shadow/`. No toca BD ni producción.

### 3. Ver los resultados del shadow  ← el que buscabas

```bash
npm run shadow:analyze
```

Lee por defecto `server/traces/shadow/*.jsonl` y produce, por medidor: tasa de null HTTP
vs Modbus, acuerdo de valores, latencias p50/p95/p99, consistencia de signo y el veredicto
contra los 5 criterios de éxito.

Para analizar un directorio o archivo específico (ej. datos de otra corrida):

```bash
node scripts/analyze-shadow.js <dir-o-archivo>
```

## Referencias

- Decisión: `docs/decisions.md` (D-118).
- Runbook de cutover/rollback: `docs/runbooks/01-Medidores y PME/cutover-modbus.md`.
- Cliente Modbus: `server/meterModbusClient.js` (`ION8650ModbusClient`, Function 03).
- Factory/toggle: `server/meterClientFactory.js`, cableado en `server/server.js`.
- Scripts: `server/scripts/probe-modbus.js`, `shadow-modbus-watch.js`, `analyze-shadow.js`.
