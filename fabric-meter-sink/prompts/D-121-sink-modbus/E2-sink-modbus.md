# D-121 · E2 — Toggle `METER_PROTOCOL` + config + factory + cableado

> Etapa self-contained. Léela con `_CONTEXTO-BASE.md` + `ESTADO.md`.

## Antes de empezar (obligatorio)
1. Leé `_CONTEXTO-BASE.md` completo y `ESTADO.md`.
2. **Verificá que E1 figure ✅** en el tablero de `ESTADO.md`. Si no, detenete y reportá.
3. Releé "Decisiones / desviaciones" y "Datos descubiertos" (sobre todo la firma real de
   `read_holding_registers` que quedó anotada en E1 — la factory/cliente deben usarla).

## Alcance de esta etapa
Cablear el cliente Modbus al service detrás del toggle `METER_PROTOCOL` (default `modbus`), sin tocar
nada aguas abajo del poller. Al terminar E2, `python -m src.main` **lee por Modbus por default** y con
`METER_PROTOCOL=http` vuelve a HTTP sin cambios de código. Una atomicidad: "el service usa Modbus vía toggle".

## Tareas

1. **`src/config.py`**:
   - Agregá `METER_PROTOCOL = os.environ.get("METER_PROTOCOL", "modbus").lower()`.
   - Agregá bloque `METER_MODBUS` (dict o constantes) leyendo de env con los defaults validados:
     `METER_MODBUS_PORT=502`, `METER_MODBUS_UNIT_ID=1`, `METER_MODBUS_REGISTER=40204`,
     `METER_MODBUS_WORD_ORDER=high`, `METER_MODBUS_DECODE=int32`, `METER_MODBUS_SCALE=1000`.
   - **`_validate()` protocol-aware** (`config.py:152-169`): si `METER_PROTOCOL == "http"`, exigí como hoy
     (`IP_*` + `USER_MEDIDORES` + `PSW_*`); si `modbus`, exigí **solo** los `IP_*` (host). Así el fail-fast
     no rompe cuando no hay credenciales HTTP configuradas.

2. **`src/meter_client_factory.py`** (nuevo) — espejando `../server/meterClientFactory.js`:
   - `make_client_factory(protocol: str, modbus_cfg) -> ClientFactory` devuelve una función con la **misma
     firma que el poller ya llama**: `(*, host, user, password, op_path, timeout_s)`.
   - Si `protocol == "modbus"`: instancia `ION8650ModbusClient(host=host, timeout_s=timeout_s, **modbus_cfg)`
     (ignora `user`/`password`/`op_path`). Si `protocol == "http"`: instancia `ION8650Client(...)` como el
     `_default_client_factory` actual. Cualquier otro valor → error claro.
   - Unit id global = 1 (de `modbus_cfg`). Dejá un comentario marcando dónde iría el override por medidor
     (`MB_UNIT_<ip_env>`) como extensión futura; no lo implementes.

3. **`src/main.py`** (`main.py:82-107`):
   - Construí `client_factory = make_client_factory(config.METER_PROTOCOL, config.METER_MODBUS)` e inyectala:
     `MeterPoller(units=config.UNITS, timeout_s=..., op_path=..., client_factory=client_factory)`.
   - Logueá a nivel INFO qué protocolo arrancó (`"Protocolo de lectura: modbus"`).
   - Agregá `pymodbus` al silenciado de librerías ruidosas a WARNING (`main.py:63-64`).
   - `_default_client_factory` (HTTP) en `meter_poller.py` **se deja intacto** (fallback para tests).

4. **`.env.example`** — agregá `METER_PROTOCOL=modbus` y las `METER_MODBUS_*` con sus defaults y un comentario
   corto del combo. **Conservá** `USER_MEDIDORES`/`PSW_*` (rollback HTTP). No borres nada.

5. **`tests/test_meter_client_factory.py`** (nuevo):
   - `protocol="modbus"` → la factory devuelve un `ION8650ModbusClient`; `protocol="http"` → `ION8650Client`.
   - La factory pasa `host`/`timeout_s` correctos al cliente Modbus y no revienta por `user`/`password`.
   - (Opcional) test de `_validate()` protocol-aware: con `modbus` no exige `PSW_*`.

## Verificación (antes de commitear)
- `pytest` (suite completa) verde: los 42 previos + `test_meter_modbus_client.py` (E1) +
  `test_meter_client_factory.py`. `test_service.py` y `test_sign_convention.py` **no debieron cambiar**.
- `ruff check` limpio sobre lo tocado.
- Wiring smoke local (sin red real de medidores): `python -m src.main` arranca, loguea "Protocolo: modbus"
  y no explota en el cableado (que falle la conexión Modbus a un host inexistente es esperado; que el
  service muera por un error de import/factory/config, no).
- Rollback: con `METER_PROTOCOL=http` en `.env`, el arranque loguea "Protocolo: http" y usa el cliente HTTP.

## Actualizar ESTADO.md (obligatorio antes de cerrar)
- Marcá E2 ✅ con resumen de una línea.
- Bloque `### E2 — Toggle + config + factory + cableado  ✅` con **Archivos tocados**, **Verificación**
  (resultado real de pytest/ruff + smoke de arranque en ambos protocolos), **Desviaciones**.

## Commit (1 commit por etapa)
```bash
git add src/config.py src/meter_client_factory.py src/main.py .env.example tests/test_meter_client_factory.py
git commit -m "$(cat <<'EOF'
feat(meter): toggle METER_PROTOCOL (default modbus) + factory en el sink Python (D-121)

Cablea ION8650ModbusClient al service detrás del flag METER_PROTOCOL (default modbus),
con factory que espeja server/meterClientFactory.js. Validación fail-fast protocol-aware
(modbus exige solo IP_*). HTTP queda como rollback con METER_PROTOCOL=http sin tocar código.
Nada aguas abajo del poller cambia: mismo destino Fabric, mismos kW, mismos signos.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> No hagas `push`/`merge`/`PR` en etapas intermedias.
