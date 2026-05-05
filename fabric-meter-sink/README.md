# fabric-meter-sink

Servicio Python on-prem que extrae lecturas de potencia (`kW total`) de los
medidores Schneider PowerLogic ION8650 de las 4 unidades de Gecelca y las
escribe a una tabla Delta en Microsoft Fabric Lakehouse cada 15 segundos.

Reemplaza al notebook de Fabric (`server/notebook.py`) que corría cada 5 min
consumiendo capacidad F2 y leía de la API `portalgeneracion`. La fuente nueva
es el medidor mismo, vía HTTP sobre la red corporativa, y la escritura va
directo a OneLake con `deltalake` (sin Spark, sin Java).

## Arquitectura

```
Medidores ION8650 (5)
    ↓ HTTP Basic Auth, /Operation.html
MeterPoller (15 s, ThreadPoolExecutor)
    ↓ sumar GEC3 + invertir signo (Gecelca)
Buffer rotativo en memoria (últimas 3 filas)
    ↓ overwrite cada 15 s con deltalake (delta-rs)
Fabric Lakehouse Delta — BRC_PGN_GENERACION_TEST
    ↓ Direct Lake
Power BI report
```

## Topología

| Unit  | Planta      | Frontera | Medidores | maxMW |
|-------|-------------|----------|-----------|-------|
| TGJ1  | Guajira 1   | output   | 1         | 145   |
| TGJ2  | Guajira 2   | output   | 1         | 130   |
| GEC3  | Gecelca 3   | input    | 2 (suman) | 164   |
| GEC32 | Gecelca 32  | input    | 1         | 270   |

Las plantas con frontera `input` (Gecelca) **invierten** el signo después de combinar.
Detalle en `../server/SIGN_CONVENTION.md`.

## Instalación

```bash
cd fabric-meter-sink
python -m venv .venv
. .venv/Scripts/activate     # PowerShell: . .venv/Scripts/Activate.ps1
pip install -e ".[dev]"
```

Copiar `.env.example` a `.env` y completar las IPs y contraseñas reales (las mismas
del repo Node).

## Uso

### Probe puntual (una vuelta a los 5 medidores)

```bash
python scripts/probe_meters.py
```

Imprime tabla con `kW` y latencia por medidor, más una línea final con el valor
combinado por unidad (después de sumar y aplicar el signo). Sale con código `0` si
todos OK, `1` si alguno falla.

### Tests

```bash
pytest -v
ruff check src tests scripts
```

Los tests **no necesitan** medidores reales — usan el fixture HTML capturado del
firmware ION8650V409 en `tests/fixtures/ion8650_op.html` y mockean `httpx`.

## Estructura

```
fabric-meter-sink/
├── pyproject.toml
├── .env.example
├── .env                     # gitignored
├── src/
│   ├── config.py            # UNITS, METER_DEFAULTS, validación fail-fast
│   ├── meter_client.py      # ION8650Client + parse_kw_total + excepciones
│   ├── meter_poller.py      # MeterPoller (sum + sign-flip)
│   └── sign_convention.py   # aplicar_signo(frontier_type, kw)
├── scripts/
│   └── probe_meters.py
└── tests/
    ├── fixtures/ion8650_op.html
    ├── test_meter_client.py
    └── test_sign_convention.py
```

## Convenciones críticas

### ⚠️ Columna `ge32` (sin C) — histórico, NO renombrar

La tabla Delta en Fabric tiene una columna **`ge32`** para la potencia de
Gecelca 32 (en lugar del esperado `gec32`). Es **intencional, no un typo**:

- El id interno de la unidad en `config.py` es `GEC32` (con C).
- Al construir la fila Fabric (`build_row` en `fabric_writer.py`), el id `GEC32`
  se mapea a la columna `ge32` (sin C).
- Hay un report Power BI en producción que ya consume esa columna por ese
  nombre. Renombrarla rompería el report.

Si en el futuro alguien quiere "arreglar" el typo, hay que coordinar con el
equipo de BI para migrar el report **antes** de cambiar la columna.

## Escritura a Fabric

`src/fabric_writer.py` escribe a una tabla Delta en un Lakehouse de Microsoft
Fabric vía OneLake (`abfss://...onelake.dfs.fabric.microsoft.com/...`).

- Cliente Delta: `deltalake` (delta-rs) — sin Spark, sin Java.
- Auth: `azure-identity.ClientSecretCredential` con scopes separados:
  - `https://storage.azure.com/.default` para writes a OneLake.
  - `https://api.fabric.microsoft.com/.default` para listar lakehouses y
    refresh del SQL endpoint. **Son tokens distintos**, no intercambiables.
- Modo: `mode='overwrite'` + `schema_mode='overwrite'` para mantener la
  semántica del notebook actual (ver `server/notebook.py`).

### Probes

```bash
# Confirmar el nombre exacto del Lakehouse (displayName puede diferir del path)
python scripts/probe_workspace.py

# Validar end-to-end: escribir 1 fila dummy y leerla de vuelta
python scripts/probe_fabric.py
```

`probe_fabric.py` reintenta automáticamente sin schema si el path con
`/dbo/` falla con "table not found" — útil para descubrir si el Lakehouse
tiene schemas habilitados.

### Schema de la tabla

| Columna     | Tipo    | Notas                                            |
|-------------|---------|--------------------------------------------------|
| `id_date`   | int64   | YYYYMMDD                                         |
| `hourx`     | int64   | 0-23 (Bogotá UTC-5)                              |
| `minutex`   | int64   | 0-59                                             |
| `secondx`   | int64   | 0-59                                             |
| `tgj1`      | float64 | TGJ1 en kW                                       |
| `tgj2`      | float64 | TGJ2 en kW                                       |
| `gec3`      | float64 | GEC3 en kW (signo invertido aplicado)            |
| `ge32`      | float64 | GEC32 en kW (signo invertido) — ⚠️ sin C, histórico |
| `uom`       | string  | `"KW"`                                           |
| `descript`  | string  | `"Potencia"`                                     |
| `ts_concat` | int64   | YYYYMMDDhhmmss (ordenable)                       |

Una unidad sin dato (todos sus medidores fallaron) escribe `0.0` (no NaN, no
NULL — el report Power BI espera numéricos).

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| HTTP 401 al obtener token | `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` mal copiados en `.env` |
| HTTP 403 al escribir | El service principal no es `Contributor` del workspace, o los settings de tenant en Fabric Admin no se han propagado (15-30 min) |
| DNS / timeout / connection refused | Firewall on-prem no abre saliente a `*.dfs.fabric.microsoft.com` o `login.microsoftonline.com` |
| "Table not found" / path inválido | Lakehouse sin schemas — `probe_fabric.py` reintenta sin schema y avisa |
| Schema mismatch en write | La tabla existe con schema distinto. `write_overwrite` usa `schema_mode='overwrite'` por defecto, debería resolverlo |

## Servicio continuo

`src/main.py` es el entry point del loop persistente. Diseñado para correr bajo
systemd con `Restart=always`. Cadencia y comportamiento están en `src/service.py`:

- Poll a 5 medidores cada **15 s** (`POLL_INTERVAL_S`, ThreadPoolExecutor).
- Buffer rotativo de **3 filas** (`BUFFER_SIZE`).
- Cada ciclo, después del poll, escribe el buffer **completo** a Fabric en
  modo `overwrite`.
- **VACUUM** cada **3 h** con retain 0 (en thread separado, no bloquea el loop).
- **Refresh SQL endpoint** cada **60 s** (best-effort).
- **Heartbeat**: `Path.touch` al `HEARTBEAT_PATH` cada ciclo — un monitor
  externo puede detectar procesos colgados con `stat`.
- **Drift compensation**: el sleep entre ciclos es `interval - elapsed`, no
  `interval` crudo, así un ciclo lento no empuja la cadencia.
- **Shutdown limpio**: SIGINT/SIGTERM corta el sleep al instante, hace un
  `flush()` final del buffer, no ejecuta VACUUM. Watchdog de 30 s fuerza salida.
- **Failure escalation**: 5 writes consecutivos fallando → exit 1, systemd
  reinicia.

### Smoke test en foreground

```powershell
# venv activo + .env poblado (medidores + Fabric)
python -m src.main
# → ver logs cada 15 s con TGJ1=… TGJ2=… GEC3=… GEC32=… → wrote N rows to Fabric
# → Ctrl+C → "shutting down" → flush final → "stopped"
```

### Despliegue Linux con systemd

`deploy/install.sh` es idempotente. Asume que el código ya está en
`/opt/fabric-meter-sink/`.

```bash
sudo rsync -av --exclude .venv ./fabric-meter-sink/ /opt/fabric-meter-sink/
# editar /opt/fabric-meter-sink/.env con credenciales reales
sudo /opt/fabric-meter-sink/deploy/install.sh

sudo systemctl start fabric-meter-sink
sudo systemctl status fabric-meter-sink
sudo journalctl -u fabric-meter-sink -f
```

### Operación

| Acción | Comando |
|---|---|
| Start | `sudo systemctl start fabric-meter-sink` |
| Stop | `sudo systemctl stop fabric-meter-sink` |
| Status | `systemctl status fabric-meter-sink` |
| Logs en vivo | `sudo journalctl -u fabric-meter-sink -f` |
| Heartbeat | `stat /var/run/fabric-meter-sink/heartbeat` (debe actualizar cada ~15 s) |
| Logs en disco | `ls -lh /opt/fabric-meter-sink/logs/` (rotación 10 MB × 5) |

### Métricas operacionales

- **Cadencia**: 15 s (`POLL_INTERVAL_S`).
- **Volumen**: ~5760 ciclos/día = 5760 writes a Fabric/día.
- **VACUUM**: cada 3 h, retain 0 horas (limpia agresivamente, igual que el notebook).
- **Refresh SQL endpoint**: cada 60 s.
- **Buffer en memoria**: 3 filas (overwrite al subir, no append).

## Apagar el notebook viejo

Una vez validado el servicio nuevo en producción durante 24 h, **apagar el
schedule del notebook** en Fabric (`server/notebook.py` en este repo). Si
ambos corren al mismo tiempo, los dos pisan la misma tabla en cadencia distinta
y el report Power BI mostrará valores oscilantes.

Plan recomendado:

1. Dejar el notebook activo durante 1 día con el servicio nuevo corriendo en
   paralelo. Validar con SQL queries que la tabla refleja cadencia de 15 s
   (los timestamps deben ir cada 15 s, no cada 5 min).
2. Apagar el schedule del notebook (no borrarlo).
3. Si todo bien por 1 semana, archivar/borrar el notebook.

Si el servicio nuevo falla, reactivar el schedule del notebook es el rollback rápido.

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| Medidor caído (log warn con host) | Red, credenciales, firmware | poller reporta `None`, fila Fabric escribe `0.0`; chequear `probe_meters.py` |
| Write a Fabric falla esporádicamente | Token expirado / red intermitente | Retry next cycle automático; escala a exit 1 después de 5 fallos consecutivos |
| HTTP 401 token | TENANT_ID/CLIENT_ID/CLIENT_SECRET mal copiados | Revisar `.env` |
| HTTP 403 al escribir | Service principal no es Contributor del workspace | Revisar Fabric Admin; settings tardan 15-30 min en propagar |
| `FriendlyNameSupportDisabled` | Tenant exige GUIDs en path | Poner `FABRIC_LAKEHOUSE_NAME` con el GUID del lakehouse (ver `probe_workspace.py`) |
| `[SSL: CERTIFICATE_VERIFY_FAILED]` | Proxy corporativo intercepta TLS | Ya manejado: `truststore.inject_into_ssl()` usa el almacén de Windows. Si IT no instaló la CA, pedírsela |
| "Table not found" / path inválido | Lakehouse sin schemas | `probe_fabric.py` reintenta sin schema y avisa |
| Schema mismatch al primer write | Tabla pre-existe con tipos distintos | `write_overwrite` usa `schema_mode='overwrite'`, debería resolverlo en el primer ciclo |
| Heartbeat no se actualiza | Proceso colgado en I/O remoto | systemd reinicia con `Restart=always`; investigar logs |
| VACUUM falla | Conflicto con writers concurrentes | Log warn, continúa; no fatal |

## Notas

- **Valores en kW**, no MW. El `uom='KW'` lo refleja. Dividir por 1000 sería un bug.
- **Aislamiento por unidad**: si **cualquier** medidor de una unidad falla, esa
  unidad reporta `value_kw = None`; al armar la fila Fabric se persiste `0.0`
  para esa columna. Las otras unidades siguen normales.
- **Polling duplicado con el dashboard Node**: el dashboard polea cada 2 s y
  este servicio cada 15 s, total ~17 req/min por medidor. Los ION8650 toleran
  esa cadencia sin problema. Optimización futura opcional: que este servicio
  sea cliente WebSocket de `ws://localhost:3001` en lugar de polear directo —
  pero rompe el aislamiento que se pidió, por ahora cada uno polea independiente.
- **Validación de medidores fail-fast** al importar `src.config`. Para saltarla
  en herramientas (tests, scripts ad-hoc): `CONFIG_SKIP_VALIDATION=1`.
- **Tests automatizados**: cubren extractor, signo, y service loop con mocks.
  La escritura real a Fabric **no** se mockea — validación end-to-end manual
  vía `probe_fabric.py` con credenciales reales.
