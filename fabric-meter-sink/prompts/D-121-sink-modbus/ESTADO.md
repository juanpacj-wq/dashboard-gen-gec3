# D-121 — ESTADO (bitácora viva)

> **Puente de contexto entre sesiones.** A diferencia de `_CONTEXTO-BASE.md` (inmutable),
> este archivo se actualiza en CADA etapa:
> - **Al empezar** una etapa: leerlo para saber qué quedó hecho, qué se descubrió y qué
>   desviaciones acumuladas hay.
> - **Al terminar** una etapa: registrar qué se hizo, archivos tocados, resultado de tests,
>   desviaciones y datos descubiertos.
> Una etapa solo se ejecuta si **todas las anteriores figuran ✅** en el tablero.

## Tablero de avance
| Etapa | Estado | Resumen |
|---|---|---|
| E0 — Andamiaje | ✅ | Carpeta `prompts/D-121-sink-modbus/` creada: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-121.md`, `ESTADO.md`, `E1..E3`. |
| E1 — Cliente Modbus + probe + tests | ✅ | `ION8650ModbusClient` (pymodbus 3.7.4, FC03, reg 40204/int32/high/scale 1000) aislado + probe + 21 tests. Suite 63 verdes, ruff limpio. Aún en HTTP en prod. |
| E2 — Toggle `METER_PROTOCOL` + config + factory + cableado | ⬜ | — |
| E3 — Smoke real + docs + cleanup + cierre | ⬜ | — |

Leyenda: ⬜ pendiente · 🟡 en progreso · ✅ hecho y probado · ⛔ bloqueado.

## Decisiones / desviaciones acumuladas
> Cambios respecto a `_CONTEXTO-BASE.md`/`PREGUNTAS` que surgieron al ejecutar. Cada uno
> con la etapa que lo originó y si tiene o no impacto funcional.
- **[E1] Modelo de error de pymodbus 3.7 ≠ modbus-serial (Node).** En Python, un timeout de
  lectura **retorna** un `ModbusIOException` (objeto con `.isError() is True`), NO lo lanza; una
  excepción de protocolo **retorna** un `ExceptionResponse` con `.exception_code`; y un fallo de
  conexión **lanza** `ConnectionException`. Por eso el cliente mapea DOS caminos: el retorno con
  `.isError()` (`_map_error_response`) y las excepciones lanzadas (`_map_error`). Sin impacto en
  paridad funcional: los tipos finales (`MeterTimeoutError`/`MeterModbusException`/`MeterError`/
  `MeterFormatError`) y su semántica son idénticos al Node.
- **[E1] Cliente inyectable simplificado.** El Node usa `modbusFactory` (callable). Acá se inyecta
  el cliente ya construido vía `client=` (más simple para el fake de tests). Sin impacto funcional.

## Datos descubiertos en ejecución
> Hechos que solo se conocen corriendo (versión real de pymodbus + firma de
> `read_holding_registers`, conectividad de los medidores por 502, latencias reales,
> lecturas de smoke). Rellenar a medida.
- **[E1] pymodbus resuelto = 3.7.4** (rango `>=3.6,<3.8`), sobre el venv local **Python 3.14.3**
  (no 3.11; el `.python-version` es informativo y `requires-python>=3.10` lo permite).
- **[E1] Firma real** `ModbusTcpClient.read_holding_registers(address, count=1, slave=1, ...)` — el
  kwarg del esclavo es **`slave=`** en 3.7.x (no `unit=`/`device_id=`). Constructor
  `ModbusTcpClient(host, port=502, timeout=..., ...)`. Métodos de conexión: `connect()->bool`,
  `is_socket_open()->bool`, `close()`.
- **[E1] Response**: éxito → `.registers` (lista uint16) + `.isError() is False`; protocolo →
  `ExceptionResponse.exception_code` + `.isError()`; IO/timeout → `ModbusIOException` (tiene
  `.isError()`, NO tiene `exception_code`). Conectividad real a los 5 medidores por 502: pendiente
  del smoke de E3.

## Bitácora por etapa
### E0 — Andamiaje  ✅
- Creados: `_CONTEXTO-BASE.md`, `PREGUNTAS-D-121.md`, `ESTADO.md`, `E1-sink-modbus.md`,
  `E2-sink-modbus.md`, `E3-docs-cleanup.md`.
- Sin código de producto todavía.

### E1 — Cliente Modbus + probe + tests  ✅
**Archivos tocados**
- `pyproject.toml` — `pymodbus>=3.6,<3.8` agregado a `dependencies`.
- `src/meter_modbus_client.py` (nuevo) — `ION8650ModbusClient` (keyword-only, conexión perezosa +
  reconexión, decode `struct` int32/float32 + word_order high/low, `kw = raw/scale` sin signo),
  helper `decode_registers`, excepción `MeterModbusException(exception_code)`; reutiliza
  `MeterError`/`MeterTimeoutError`/`MeterFormatError`/`MeterReading` de `meter_client.py`.
- `scripts/probe_modbus.py` (nuevo) — espejo Modbus de `probe_meters.py` (combo por env, tabla
  kw+latencia por medidor y combinado por unidad).
- `tests/test_meter_modbus_client.py` (nuevo) — 21 tests con fake pymodbus inyectado (`client=`).

**Verificación (real)**
- `pip install -e .` → instaló `pymodbus 3.7.4` sin conflictos.
- `pytest tests/test_meter_modbus_client.py -q` → **21 passed**.
- `pytest` (suite completa) → **63 passed** (42 baseline + 21 nuevos; nada degradado).
- `ruff check` sobre los 3 archivos → **All checks passed**.
- Service sin cablear: `src/service.py` sigue importando `ION8650Client` (HTTP); el poller sigue con
  `_default_client_factory`. Comportamiento en prod sin cambios.

**Desviaciones**: ver bloque "Decisiones / desviaciones acumuladas" (modelo de error pymodbus vs
Node; inyección de cliente vía `client=` en vez de `modbusFactory`). Ninguna con impacto en paridad.

<!-- Cada etapa agrega su bloque: ### EX — <título>  ✅ con Archivos tocados / Verificación / Desviaciones. -->
