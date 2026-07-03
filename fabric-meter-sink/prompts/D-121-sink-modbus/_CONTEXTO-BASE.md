# D-121 — Contexto base (compartido por todas las etapas)

> Este archivo es el **bloque de contexto acumulado** que cada prompt de etapa referencia.
> Es **inmutable** una vez cerrada la fase de planificación: si algo cambia durante la
> ejecución, se registra en `ESTADO.md` (desviaciones), no acá.
> Léelo completo al iniciar cualquier etapa, junto con `ESTADO.md`.
> Repo: `dashboard-gen-gec3/fabric-meter-sink/` — subproyecto Python 3.11 independiente,
> servicio on-prem systemd (`python -m src.main`). No es el backend Node ni tiene puerto.

## Objetivo

Migrar la **lectura del medidor** de `fabric-meter-sink` de HTTP scraping (`/Operation.html` con
`httpx` + BeautifulSoup) a **Modbus TCP**, replicando el combo ya validado por el backend Node
(D-118/D-120). El destino no cambia: sigue escribiendo cada 15 s a la misma tabla Delta en Microsoft
Fabric Lakehouse, en kW, con el mismo esquema. **Paridad funcional exacta**; solo cambia el protocolo.

**Fuera de alcance:** el destino Fabric (esquema, columna `ge32`, buffer overwrite, TZ), la lógica de
signos/combine, el loop del service. NO toca contratos cross-repo (Bitácora↔Dashboard); es interno al
subproyecto Python. El HTTP se conserva como rollback vía toggle.

## Fuentes / insumos

- **Combo Modbus a portar** (fuente de verdad, validado en sombra 3 h por el Node, 0.00 % null vs HTTP):
  - Cliente de referencia: `../server/meterModbusClient.js` (`ION8650ModbusClient`, `modbus-serial`).
  - Doc del combo: `../docs/combo-modbus-ion8650.md`; runbook `../docs/runbooks/01-Medidores y PME/cutover-modbus.md`.
  - Parámetros: registro **40204** → offset PDU **203** (`register − 40001`, base 40001), count **2**,
    **FC03** `read_holding_registers`, decode **int32 con signo**, word order **high** (ABCD, big-endian),
    escala **/1000**, unit id **1**, puerto **502**.
- **IPs de los medidores**: variables de entorno existentes `IP_TGJ1`, `IP_TGJ2`, `IP_GEC3_1`, `IP_GEC3_2`,
  `IP_GEC32` (se reutilizan tal cual; Modbus usa el host, no las credenciales HTTP).

## Destino (lo que ya existe, NO se toca)

- **Sink Fabric** `src/fabric_writer.py`: esquema Delta `TABLE_SCHEMA` (`fabric_writer.py:50-62`),
  `build_row` (`:77-109`), mapping unidad→columna `TGJ1→tgj1 / TGJ2→tgj2 / GEC3→gec3 / GEC32→ge32`
  (⚠️ `ge32` **sin C**, histórico, report Power BI en prod — no renombrar). Valores en **kW**, `uom='KW'`.
- **Loop** `src/service.py` (`FabricMeterSinkService`): poll → buffer `deque(maxlen=3)` → `write_overwrite`.
- **Signos** `src/sign_convention.py` (`aplicar_signo`, invierte `input`, normaliza `-0.0→+0.0`).

## Punto de inserción (lo que ya existe y se reutiliza)

- **Contrato del cliente** — `Protocol _ClientLike` (`src/meter_poller.py:28-30`):
  ```python
  def fetch_kw_total(self) -> dict[str, Any]: ...   # debe traer "kw": float, en kW, sin signo
  def close(self) -> None: ...
  ```
  El poller solo consume `result["kw"]` (`meter_poller.py:110`: `float(result["kw"])`).
- **Factory inyectable** — `MeterPoller(..., client_factory=...)` (`meter_poller.py:55,73,81-87`). El poller
  llama a la factory con firma `(*, host, user, password, op_path, timeout_s)`. Reutilizamos ese punto:
  una factory nueva decide HTTP vs Modbus según el toggle. `_default_client_factory` (HTTP,
  `meter_poller.py:36-45`) se conserva intacto como fallback para tests.
- **Cliente HTTP de referencia** — `src/meter_client.py`: `ION8650Client`, `MeterReading` (`TypedDict`,
  `:29-32`), jerarquía de errores `MeterError(.host)` / `MeterTimeoutError` / `MeterFormatError` (`:35-56`).
  El nuevo cliente Modbus **reutiliza esa jerarquía** y agrega `MeterModbusException`.

## Patrones de infraestructura a reutilizar

- **Config** `src/config.py`: `METER_DEFAULTS` (`:50-53`), dataclasses frozen `Meter`/`Unit`, topología
  `_TOPOLOGY` (`:96-117`), `_build_units` (`:120-149`), `_validate` fail-fast (`:152-169`, saltable con
  `CONFIG_SKIP_VALIDATION=1`). Todo lee env con `os.environ.get` a nivel de módulo.
- **Tests**: pytest plano, sin plugins. `conftest.py` setea `CONFIG_SKIP_VALIDATION=1`. Patrón de
  desacople: el cliente se mockea inyectando un fake con `fetch_kw_total()`/`close()`
  (ver `tests/test_sign_convention.py:78-101` y el `transport=` de `tests/test_meter_client.py:130-133`).
  `test_service.py` y `test_sign_convention.py` NO deben cambiar.
- **Probe** de referencia: `scripts/probe_meters.py` (lectura puntual a los 5 medidores, imprime kw+latencia).
- **TZ**: lecturas `fetched_at` en UTC (`datetime.now(timezone.utc).isoformat()`); la fila Fabric usa Bogotá
  offset fijo `-5h` en `fabric_writer.now_bogota_utc5()` (no tocar).
- **Logging**: stdlib `logging.getLogger(__name__)`, mensajes en español. `main.py` silencia libs ruidosas
  a WARNING (`main.py:63-64`) — agregar `pymodbus` a esa lista.

## Diseño D-121 (acordado)

> Volcado de `PREGUNTAS-D-121.md`, en forma técnica accionable.

### Módulos nuevos
- `src/meter_modbus_client.py` — `ION8650ModbusClient`. Constructor keyword-only: `host` (req),
  `port=502`, `unit_id=1`, `register=40204`, `word_order="high"`, `decode="int32"`, `scale=1000.0`,
  `timeout_s=4.0`, `client=None` (pymodbus-like inyectable para tests). `offset = register − 40001`.
  Conexión persistente perezosa + reconexión al fallar (espeja `#ensureConnected`/`#markDisconnected`).
- `src/meter_client_factory.py` — `make_client_factory(protocol, modbus_cfg) -> ClientFactory` que espeja
  `../server/meterClientFactory.js`: devuelve una función con la firma `(*, host, user, password, op_path,
  timeout_s)` que instancia `ION8650ModbusClient` (modbus) o `ION8650Client` (http).
- `scripts/probe_modbus.py` — lectura Modbus puntual a los 5 medidores (para el smoke de E3).

### Lógica núcleo (decode — equivalente exacto al `readInt32BE` del Node)
```python
import struct
regs = result.registers            # [reg0, reg1] uint16, count=2
# word 'high' (ABCD):
raw = struct.unpack(">i", struct.pack(">HH", regs[0], regs[1]))[0]
# word 'low'  (CDAB):  struct.pack(">HH", regs[1], regs[0])
# decode float32:      struct.unpack(">f", ...)[0]  (scale=1)
kw = raw / scale                   # → kW, sin signo
```
Validar `len(regs) >= 2` y `math.isfinite(kw)`; si no → `MeterFormatError`. NO aplicar signo.
Mapeo de errores análogo a `#mapError`: timeout→`MeterTimeoutError`, excepción de protocolo (0x83…)→
`MeterModbusException(exception_code)`, conexión/red→`MeterError`, respuesta corta/no finita→`MeterFormatError`.

### Config / cambios
- `src/config.py`: `METER_PROTOCOL = os.environ.get("METER_PROTOCOL","modbus").lower()` + bloque
  `METER_MODBUS` (`port/unit_id/register/word_order/decode/scale` desde `METER_MODBUS_*`, con los defaults
  validados). `_validate()` protocol-aware: con `modbus` solo exige `IP_*`; `USER_MEDIDORES`/`PSW_*` solo con `http`.
- `src/main.py`: construir la factory con `config.METER_PROTOCOL`/`config.METER_MODBUS` e inyectarla en
  `MeterPoller(..., client_factory=...)`. Agregar `pymodbus` al silenciado de logs.
- `pyproject.toml`: agregar `pymodbus` (pinear rango, p. ej. `>=3.6,<3.8`; verificar en E1 el kwarg exacto
  `slave=`/firma de `read_holding_registers` de la versión instalada).
- `.env.example`: agregar `METER_PROTOCOL=modbus` + `METER_MODBUS_*`; conservar `USER_MEDIDORES`/`PSW_*`.

### Tests
- Nuevos: `tests/test_meter_modbus_client.py` (fake pymodbus inyectado), `tests/test_meter_client_factory.py`.
- Intactos: `tests/test_service.py`, `tests/test_sign_convention.py`.

## Convenciones a respetar

- Valores persistidos en **kW** (no MW). Dividir por 1000 en el sink sería un bug (el report BI espera kW).
- Columna `ge32` (sin C) **no se renombra**.
- Aislamiento por unidad y sign flip a nivel unidad se mantienen tal cual (aguas arriba).
- `pymodbus`/logs ruidosos a WARNING. No romper el service si un medidor no responde (ya lo maneja el poller).
- Migración segura: default a Modbus pero HTTP disponible con `METER_PROTOCOL=http` sin tocar código.
- Idioma de todo artefacto, docstring y comentario: **tuteo colombiano estándar, sin voseo**.
