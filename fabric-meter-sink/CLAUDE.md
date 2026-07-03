# CLAUDE.md — fabric-meter-sink

Servicio Python on-prem que extrae lecturas de potencia (`kW total`) de los 5 medidores Schneider PowerLogic ION8650 de las 4 unidades de Gecelca y las escribe a una tabla Delta en Microsoft Fabric Lakehouse cada 15 segundos.

**Es un subproyecto Python independiente** que vive dentro del repo `dashboard-gen-gec3/`. Replica la lógica de extracción del Node backend (`server/meterPoller.js`) en Python, pero su destino es Microsoft Fabric (no la BD MSSQL del dashboard). Ambas extracciones corren en paralelo en el mismo server on-prem.

## Inicio rápido — qué leer

- **README completo**: `README.md` (autoritativo, ~750 líneas con detalle exhaustivo).
- **Convención de signos** (idéntica al Node side): `../server/SIGN_CONVENTION.md`.
- **Runbook de despliegue**: `DEPLOY.md` (gitignored, vive solo localmente — contiene IPs/credenciales/paths).
- **Decisiones del extractor en Node** (espejo conceptual): `../docs/decisions.md`, decisión D-112.

## Qué reemplaza

Reemplaza el notebook de Fabric (`../notebook.py` o `notebook.py` en raíz Fabric) que corría cada 5 min consumiendo capacidad F2 y leía de la API `portalgeneracion`. Acá:

- **Fuente nueva** — directo del medidor (Modbus TCP red corp desde D-121; HTTP como rollback), sin pasar por la API portal (obsoleta).
- **Cadencia fina** — 15 s vs 5 min del notebook.
- **Cero capacidad Fabric** — corre on-prem, escribe directo a OneLake con `deltalake` (sin Spark, sin Java, sin notebook).

## Stack

- **Python 3.11** (pinned via `.python-version` informativo).
- **pymodbus** — cliente Modbus TCP (FC03), **fuente de lectura primaria** desde D-121.
- **httpx** — cliente HTTP sync (Basic Auth + timeout), **solo rollback** (`METER_PROTOCOL=http`).
- **BeautifulSoup** — parser HTML del firmware ION 8650V409, solo en el rollback HTTP.
- **deltalake** (delta-rs) — escritura Delta sin Spark.
- **pyarrow** — Arrow Tables para `write_deltalake`.
- **azure-identity** — auth para OneLake/Fabric (DefaultAzureCredential + cache propio de tokens).
- **pytest** — 70 tests: cliente Modbus, factory, cliente HTTP, signos, loop principal.

## Estructura

```
fabric-meter-sink/
├── pyproject.toml             Deps + hatchling + ruff/pytest config
├── .env.example               Template (gitignored: .env real)
├── .python-version            3.11
├── src/
│   ├── config.py              UNITS, METER_DEFAULTS, vars Fabric, fail-fast
│   ├── sign_convention.py     aplicar_signo(frontier_type, kw)
│   ├── meter_client.py        ION8650Client + parse_kw_total + excepciones tipadas
│   ├── meter_poller.py        MeterPoller (poll concurrente con ThreadPoolExecutor + sign flip)
│   ├── fabric_writer.py       FabricWriter + build_row + now_bogota_utc5
│   ├── service.py             FabricMeterSinkService (loop principal)
│   └── main.py                Entry: `python -m src.main`
├── scripts/
│   ├── probe_meters.py        Probe puntual a los 5 medidores
│   ├── probe_workspace.py     Lista items del workspace Fabric
│   └── probe_fabric.py        Write+read 1 fila dummy (validación E2E)
├── tests/                     42 tests (pytest)
│   ├── conftest.py            CONFIG_SKIP_VALIDATION=1 para tests
│   ├── fixtures/ion8650_op.html   HTML real ION8650V409 capturado
│   ├── test_meter_client.py   20 tests (HTTP + parser + excepciones)
│   ├── test_sign_convention.py    10 tests
│   └── test_service.py        12 tests del loop con mocks
└── deploy/
    ├── fabric-meter-sink.service  systemd unit
    └── install.sh                 Instalador idempotente Linux
```

## Topología (compartida con Node side)

| Unit | Planta | Frontera | Medidores | maxMW | Inversión signo |
|---|---|---|---|---|---|
| TGJ1 | Guajira 1 | output | 1 | 145 | No |
| TGJ2 | Guajira 2 | output | 1 | 130 | No |
| GEC3 | Gecelca 3 | input | 2 (suman) | 164 | **Sí** (después de sumar) |
| GEC32 | Gecelca 32 | input | 1 | 270 | **Sí** |

Misma topología que `../server/config.js`. Si una cambia, la otra también. Detalle físico de por qué Gecelca tiene signo invertido en `../server/SIGN_CONVENTION.md`.

## Convenciones críticas (no obvias)

1. **Columna `ge32` (sin C) en Fabric — histórico, NO renombrar.** El id interno de la unidad en `config.py` es `GEC32` (con C), pero `build_row` en `fabric_writer.py` lo mapea a la columna `ge32` (sin C). Hay un report Power BI en producción consumiéndola. Renombrar rompería el report. Si en el futuro alguien quiere "arreglar el typo", coordinar con BI primero.

2. **Valores en kW, no MW.** Se persisten en kilowatts. `uom='KW'`. Dividir por 1000 sería un bug — el report Power BI espera kW.

3. **Aislamiento por unidad** (idéntico al Node side): si CUALQUIER medidor de una unidad falla en un ciclo, esa unidad reporta `value_kw=None`. En `build_row`, unidades con `value_kw=None` se persisten como `0.0` (no se omite la columna).

4. **Inversión de signo a nivel unidad** (después de combinar). Mismo patrón que Node. Para GEC3 con `combine='sum'`: primero `sum`, después `aplicar_signo`. Función pura en `sign_convention.py` que normaliza `-0.0 → +0.0`.

5. **Validación fail-fast al cargar `config.py`, protocol-aware**: con `METER_PROTOCOL=modbus` (default) solo exige las `IP_*`; con `http` exige además `USER_MEDIDORES`/`PSW_*`. Levanta `ValueError` con la lista **completa** de variables faltantes. Saltable con `CONFIG_SKIP_VALIDATION=1` para tests/scripts ad-hoc.

6. **Cache de tokens por scope** en `fabric_writer.py`. Los scopes son DISTINTOS:
   - `https://storage.azure.com/.default` para writes a OneLake.
   - `https://api.fabric.microsoft.com/.default` para listar lakehouses / refresh del SQL endpoint.
   - Cache propio con margen de 60s antes de expirar (encima del cache de `azure-identity`).

7. **Detección automática GUID vs displayName del lakehouse**: si `lakehouse_name` matchea un UUID, omite el sufijo `.Lakehouse` (necesario en tenants con `FriendlyNameSupportDisabled`). Si es un nombre, lo agrega.

8. **`MeterFormatError` separado de errores de red.** HTTP: 200 pero sin celda `kW total` / no-`kW` / número no finito. Modbus: respuesta con <2 registros o valor no finito. Ambos son señal de **cambio de firmware/Modbus map**, NO transitorio. Operador debe verlo. (Modbus además: `MeterModbusException` con `exception_code` para excepciones de protocolo 0x83… — p. ej. 0x02 = Modbus Map bloqueado por Advanced Security.)

9. **TZ Bogotá vía offset fijo (`-5h`), no zoneinfo.** `now_bogota_utc5()` usa offset manual para evitar dependencia de `tzdata` en Windows. Colombia no tiene DST, offset puro es seguro.

10. **Buffer rotativo de 3 filas + overwrite.** Cada 15s `write_overwrite(buffer)` escribe el buffer completo en `mode='overwrite' + schema_mode='overwrite'`. La tabla siempre refleja los últimos 3 ciclos. Ordenable por `ts_concat`.

11. **Toggle `METER_PROTOCOL` (default `modbus`).** La lectura es Modbus TCP (`ION8650ModbusClient`, FC03, registro 40204/int32/high/scale 1000, unit 1, puerto 502) replicando el combo del Node. `make_client_factory` (`meter_client_factory.py`) elige cliente por protocolo y lo inyecta en `MeterPoller`; con `http` vuelve al scraping sin tocar código (rollback). El poller/service son agnósticos del protocolo. Detalle en `../docs/decisions.md` **D-121** (espejo de `[[D-118]]`).

## Loop principal (`service.py`)

Una iteración:

1. `units = poller.poll()` — paralelo, 4-5s peor caso. ThreadPoolExecutor sobre los 5 medidores.
2. Si al menos una unidad reportó valor: `build_row(units, now_bogota)` y push al buffer.
3. `writer.write_overwrite(list(buffer))` — escribe buffer completo a Delta.
4. Cada 60s: refresh del SQL endpoint (best-effort, nunca lanza).
5. Cada 3h: dispatch de VACUUM en thread separado (no bloquea el loop).
6. `Path.touch` al `HEARTBEAT_PATH`.

## Comandos

- **Setup local**:
  ```bash
  cd fabric-meter-sink
  python -m venv .venv && source .venv/Scripts/activate    # Windows: .venv\Scripts\activate
  pip install -e .
  cp .env.example .env && nano .env
  python -m src.main
  ```

- **Tests**:
  ```bash
  pytest                       # 42 tests
  pytest tests/test_meter_client.py -v
  ```

- **Probes**:
  ```bash
  python -m scripts.probe_meters       # Probe los 5 medidores
  python -m scripts.probe_workspace    # Lista items Fabric workspace
  python -m scripts.probe_fabric       # Write+read dummy E2E
  ```

- **Deploy Linux** (idempotente):
  ```bash
  cd fabric-meter-sink/deploy && sudo ./install.sh
  sudo systemctl status fabric-meter-sink
  sudo journalctl -u fabric-meter-sink -f
  ```

## Variables de entorno

Definidas en `.env` (ver `.env.example`). Validación fail-fast **protocol-aware** en `config.py`
(los nombres reales que usa el código, no `METER_*_HOST`/`FABRIC_TENANT_ID`):

- **Hosts de medidores** (siempre requeridos): `IP_TGJ1`, `IP_TGJ2`, `IP_GEC3_1`, `IP_GEC3_2`, `IP_GEC32`.
- **Protocolo de lectura**: `METER_PROTOCOL` (`modbus` default | `http`) + combo Modbus `METER_MODBUS_{PORT=502,UNIT_ID=1,REGISTER=40204,WORD_ORDER=high,DECODE=int32,SCALE=1000}`.
- **Credenciales HTTP** (solo requeridas con `METER_PROTOCOL=http`): `USER_MEDIDORES` (usuario compartido) + `PSW_TGJ1`, `PSW_TGJ2`, `PSW_GEC3_1`, `PSW_GEC3_2`, `PSW_GEC32`.
- **Defaults de lectura**: `METER_OP_PATH` (rollback HTTP), `METER_TIMEOUT_S`, `POLL_INTERVAL_S=15`, `BUFFER_SIZE=3`.
- **Fabric**: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` (service principal), `FABRIC_WORKSPACE_ID`, `FABRIC_LAKEHOUSE_NAME` (GUID o displayName), `FABRIC_LAKEHOUSE_SCHEMA` (opcional), `FABRIC_TABLE_NAME` (`BRC_PGN_GENERACION_MEDIDORES`), `FABRIC_SQL_ENDPOINT_ID` (opcional).
- **Operación**: `HEARTBEAT_PATH`, `LOG_DIR`, `LOG_LEVEL`, `MAX_CONSECUTIVE_WRITE_FAILURES=5`, `SHUTDOWN_TIMEOUT_S=30`.

`CONFIG_SKIP_VALIDATION=1` salta la validación (uso solo en tests/scripts).

## Relación con el Node backend

Este servicio y el Node backend (`../server/`) hacen extracción **paralela e independiente**:

- **Node** (`meterPoller.js` + `extractorOrchestrator.js`): cada 2s, persiste a MSSQL local (`dashboard.generacion_*`), broadcast WS al dashboard frontend. Tiene fallback a PMEScraper.
- **Python (este)**: cada 15s, escribe a Microsoft Fabric Lakehouse. Sin fallback PME.

Ambos comparten convenciones (signos, aislamiento por unidad, topología), pero NO comparten código. Si la topología cambia (e.g., nuevo medidor, IP nueva), ambos lados deben actualizarse en paralelo.

## Cómo evolucionar este archivo

**Agregá una entrada SOLO cuando:**
- Cambia la topología de medidores (nuevo meter, nueva unidad, frontera distinta).
- Cambia el formato de la tabla Delta destino (columna nueva, rename — cuidado con D-112 sobre `ge32`).
- Cambia el protocolo de auth con Fabric o OneLake (e.g., service principal nuevo).
- Encontraste un edge case del firmware ION que rompe el parser.

**NO agreges:**
- Qué hace el código (los nombres ya lo dicen).
- Cambios menores en deps, refactors, version bumps — `git log` es suficiente.
- Decisiones grandes — van a `../docs/decisions.md` (con prefijo `D-2NN` para distinguir Python del Node) o en este archivo como una entrada corta con link al ADR.

**Reglas de tamaño:**
- 1-3 frases por entrada.
- Si crece >200 líneas, mover detalle al `README.md` (que ya es exhaustivo) y dejar solo pointers.

**Decisiones grandes**: ADR-lite en `../docs/decisions.md`. Numerar `D-2NN` para subproyecto Python (Node usa `D-1NN`, Bitácora `D-0NN` en su docs).
