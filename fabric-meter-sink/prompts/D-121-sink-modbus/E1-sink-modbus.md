# D-121 · E1 — Cliente Modbus + probe + tests unitarios

> Etapa self-contained. Un Claude futuro que no leyó el chat de planeación debe poder
> ejecutarla solo con este archivo + `_CONTEXTO-BASE.md` + `ESTADO.md` + el contexto del subrepo.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. Esta es la **primera** etapa de código; no hay etapas previas que verificar más allá de E0 ✅.
3. Releé las "Decisiones / desviaciones acumuladas" y "Datos descubiertos" de `ESTADO.md`.
4. Abrí `../server/meterModbusClient.js` como referencia viva del combo y del mapeo de errores.

## Alcance de esta etapa
Crear el cliente Modbus **aislado**, su probe y sus tests unitarios. **No** se cablea al service todavía
(el toggle y el wiring van en E2). Al terminar E1, `python -m src.main` sigue leyendo por HTTP, sin cambios
de comportamiento en producción. Una sola atomicidad: "existe un `ION8650ModbusClient` probado".

## Tareas

1. **`pyproject.toml`** — agregar `pymodbus` a `dependencies` (pinear rango, sugerido `pymodbus>=3.6,<3.8`).
   Tras instalar (`pip install -e .`), **verificá la firma real** de `read_holding_registers` de la versión
   instalada (el kwarg del esclavo cambió entre versiones: `slave=` / `unit=` / `device_id=`). Anotá la
   versión y la firma exacta en "Datos descubiertos" de `ESTADO.md`.

2. **`src/meter_modbus_client.py`** (nuevo) — `ION8650ModbusClient`:
   - Constructor keyword-only: `host` (req, si vacío → `TypeError`/`ValueError` como el HTTP),
     `port=502`, `unit_id=1`, `register=40204`, `word_order="high"`, `decode="int32"`, `scale=1000.0`,
     `timeout_s=4.0`, `client=None` (pymodbus-like inyectable para tests).
   - `offset = register - 40001` (validar `register >= 40001`, `word_order ∈ {high,low}`, `decode ∈ {int32,float32}`).
   - Conexión persistente perezosa: `_ensure_connected()` (re-conecta solo si no está abierto);
     `_mark_disconnected()` cierra y fuerza reconexión al próximo fetch (espeja el Node).
   - `fetch_kw_total() -> MeterReading` (reutilizá el `TypedDict` `MeterReading` de `meter_client.py`, o
     redefinilo idéntico): lee 2 registros por FC03, decodifica con `struct` (ver bloque en
     `_CONTEXTO-BASE.md` → Lógica núcleo), `kw = raw / scale`. Devuelve
     `{"kw": float, "fetched_at": now-UTC-iso, "latency_ms": int}`. **kW sin signo aplicado.**
   - `close() -> None` — cierra el socket, swallowa excepciones.
   - Errores: reutilizá `MeterError` (con `.host`), `MeterTimeoutError`, `MeterFormatError` de
     `meter_client.py`; agregá `MeterModbusException(MeterError)` con atributo `exception_code`. Mapeo
     análogo a `#mapError` del Node: timeout→`MeterTimeoutError`, excepción de protocolo (0x83…)→
     `MeterModbusException`, conexión/red→`MeterError`, `len(regs)<2` o valor no finito→`MeterFormatError`.
   - Docstrings/comentarios en español (tuteo colombiano).

3. **`scripts/probe_modbus.py`** (nuevo) — espejando `scripts/probe_meters.py`: instancia un
   `ION8650ModbusClient` por medidor de `config.UNITS`, hace una lectura e imprime `unit/host/kw/latency_ms`
   (y error tipado si falla). Sirve para el smoke de E3. Corre con `CONFIG_SKIP_VALIDATION` si hace falta.

4. **`tests/test_meter_modbus_client.py`** (nuevo) — fake pymodbus inyectado vía `client=` (objeto con
   `connect()`, `read_holding_registers(...)` → objeto con `.registers` y `.isError()`, `close()`, y forma
   de simular excepciones/timeouts). Casos mínimos:
   - int32 high: registros que codifican `145000` → `kw == 145.0`.
   - Negativos de Gecelca (int32 con signo) → `kw < 0`, **sin** inversión (el cliente no aplica signo).
   - `word_order="low"` decodifica con swap correcto.
   - `decode="float32"` con `scale=1`.
   - `scale` distinto (p. ej. 40033/scale=10) da el valor esperado.
   - timeout → `MeterTimeoutError`; excepción de protocolo → `MeterModbusException` (con `exception_code`);
     respuesta corta (`len(regs)<2`) o valor no finito → `MeterFormatError`.

## Verificación (antes de commitear)
- `pip install -e .` instala `pymodbus` sin conflictos.
- `pytest tests/test_meter_modbus_client.py -v` — todos verdes.
- `pytest` (suite completa) — sigue en el baseline (los 42 previos verdes; no se degradó nada).
- `ruff check src/meter_modbus_client.py scripts/probe_modbus.py tests/test_meter_modbus_client.py` limpio.
- El service sigue en HTTP (no se cableó nada): `python -m src.main` no cambió su comportamiento.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E1 ✅ en el tablero con resumen de una línea.
- Bloque `### E1 — Cliente Modbus + probe + tests  ✅` con **Archivos tocados**, **Verificación**
  (resultado real de pytest/ruff), **Desviaciones**.
- En "Datos descubiertos": versión exacta de `pymodbus` instalada y firma real de
  `read_holding_registers` (kwarg del esclavo).

## Commit (1 commit por etapa)
```bash
git add pyproject.toml src/meter_modbus_client.py scripts/probe_modbus.py tests/test_meter_modbus_client.py
git commit -m "$(cat <<'EOF'
feat(meter): cliente Modbus TCP ION8650 para el sink Python (D-121)

Agrega ION8650ModbusClient (pymodbus, FC03, registro 40204/int32/high/scale 1000)
replicando el combo ya validado por el backend Node. Devuelve kW sin signo, mismo
contrato fetch_kw_total() que el cliente HTTP. Aislado: aún no cableado al service
(el toggle va en E2). Incluye probe scripts/probe_modbus.py y tests con fake pymodbus.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias.
