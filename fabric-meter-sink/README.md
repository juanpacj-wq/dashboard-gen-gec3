# fabric-meter-sink

Servicio Python on-prem que extrae lecturas de potencia (`kW total`) de los
medidores Schneider PowerLogic ION8650 de las 4 unidades de generación de
Gecelca y las escribe a una tabla Delta en Microsoft Fabric Lakehouse cada 15
segundos.

Reemplaza al notebook de Fabric (`server/notebook.py`) que corría cada 5 min
consumiendo capacidad F2 y leía de la API `portalgeneracion`. Acá:

- **Fuente nueva** — directo del medidor, vía HTTP en la red corporativa, sin
  pasar por la API portal (que quedó obsoleta).
- **Cadencia mucho más fina** — 15 s vs 5 min del notebook.
- **Cero capacidad Fabric consumida** — el servicio corre en el mismo server
  on-prem donde vive el dashboard Node, escribiendo directo a OneLake con
  `deltalake` (sin Spark, sin Java, sin notebook).

## Arquitectura

```
Medidores ION8650 (5)
    ↓ HTTP Basic Auth, /Operation.html
MeterPoller (15 s, ThreadPoolExecutor)
    ↓ sumar GEC3 + invertir signo (Gecelca)
Buffer rotativo en memoria (últimas 3 filas)
    ↓ overwrite cada 15 s con deltalake (delta-rs)
Fabric Lakehouse Delta — BRC_PGN_GENERACION_MEDIDORES
    ↓ Direct Lake
Power BI report
```

Cinco medidores físicos repartidos en cuatro unidades. Cada ciclo de 15 s lee
los cinco en paralelo, los combina/invierte por unidad, los acumula en un
buffer rotativo de 3 filas, y escribe ese buffer completo a Fabric en modo
`overwrite` — la tabla siempre refleja los últimos 3 registros, ordenables por
`ts_concat`.

## Topología

| Unit  | Planta      | Frontera | Medidores | maxMW | Inversión de signo |
|-------|-------------|----------|-----------|-------|---------------------|
| TGJ1  | Guajira 1   | output   | 1         | 145   | No                 |
| TGJ2  | Guajira 2   | output   | 1         | 130   | No                 |
| GEC3  | Gecelca 3   | input    | 2 (suman) | 164   | Sí (después de sumar) |
| GEC32 | Gecelca 32  | input    | 1         | 270   | Sí                 |

Detalle de la inversión en `../server/SIGN_CONVENTION.md`.

## Convenciones críticas

### Inversión de signo Gecelca

Las plantas Gecelca tienen el medidor instalado en la frontera de **entrada**
de energía (donde la planta toma auxiliares de la red), así que cuando la
unidad genera neto, la lectura es **negativa**. El `MeterPoller` invierte el
signo a nivel **unidad** (después de combinar todos sus medidores) para que
todo aguas abajo vea la convención canónica del PME (positivo = generación
neta).

Las Guajiras tienen frontera **output** y el medidor reporta directamente con
el signo correcto — no se invierte.

### ⚠️ Columna `ge32` (sin C) — histórico, NO renombrar

La tabla Delta en Fabric tiene una columna **`ge32`** para Gecelca 32 (no
`gec32`). Es **intencional, no un typo**:

- El id interno de la unidad en `config.py` es `GEC32` (con C).
- Al construir la fila Fabric (`build_row` en `fabric_writer.py`), `GEC32` se
  mapea a la columna `ge32`.
- Hay un report Power BI en producción que ya consume esa columna por ese
  nombre. Renombrarla rompería el report.

Si en el futuro alguien quiere "arreglar" el typo, hay que coordinar con BI
para migrar el report **antes** de cambiar la columna.

### Valores en kW, no MW

Los valores se persisten en **kilowatts**, no megawatts. El campo `uom='KW'`
lo refleja. Dividir por 1000 sería un bug — el report Power BI espera kW.

## Estructura del proyecto

```
fabric-meter-sink/
├── pyproject.toml               # deps + setup hatchling + ruff/pytest config
├── .env.example                 # template (gitignored: .env real)
├── .gitignore                   # incluye DEPLOY.md y secretos genéricos
├── .python-version              # 3.11 (informativo)
├── src/
│   ├── config.py                # UNITS, METER_DEFAULTS, vars Fabric, fail-fast
│   ├── sign_convention.py       # aplicar_signo(frontier_type, kw)
│   ├── meter_client.py          # ION8650Client + parse_kw_total + excepciones
│   ├── meter_poller.py          # MeterPoller (poll concurrente + sign flip)
│   ├── fabric_writer.py         # FabricWriter + build_row + now_bogota_utc5
│   ├── service.py               # FabricMeterSinkService (loop principal)
│   └── main.py                  # entry point — `python -m src.main`
├── scripts/
│   ├── probe_meters.py          # probe puntual a los 5 medidores
│   ├── probe_workspace.py       # lista items del workspace Fabric
│   └── probe_fabric.py          # write+read 1 fila dummy (validación E2E)
├── tests/                       # 42 tests (pytest)
│   ├── conftest.py              # CONFIG_SKIP_VALIDATION=1 para tests
│   ├── fixtures/ion8650_op.html # HTML real ION8650V409 capturado del medidor
│   ├── test_meter_client.py     # 20 tests del cliente HTTP + parser
│   ├── test_sign_convention.py  # 10 tests de convención de signos
│   └── test_service.py          # 12 tests del loop con mocks
└── deploy/
    ├── fabric-meter-sink.service    # systemd unit
    └── install.sh                   # instalador idempotente Linux
```

`DEPLOY.md` (runbook de despliegue paso a paso) **vive en el filesystem
local pero está gitignored** — contiene detalles de infraestructura.

## Componentes implementados

### 1. Capa de extracción (medidores ION8650)

`src/meter_client.py` — **`ION8650Client`**:

- Cliente HTTP con `httpx` (sync) + `BeautifulSoup` para parsing.
- Hace `GET /Operation.html` con HTTP Basic Auth, parsea el `<td class="v">N kW</td>`
  adyacente al label `kW total`.
- Excepciones tipadas — distingue auth (401), HTTP genérico (otros 4xx/5xx),
  timeout, y formato (HTML inesperado):
  - `MeterAuthError`, `MeterHttpError`, `MeterTimeoutError`, `MeterFormatError`
    (todas heredan de `MeterError`).
- Acepta `host` con o sin scheme (`192.168.0.1` o `http://192.168.0.1`).

`src/meter_poller.py` — **`MeterPoller`**:

- Hace `poll()` sincrónico que dispara las 5 lecturas en paralelo con
  `ThreadPoolExecutor`.
- **Aislamiento por unidad**: si CUALQUIER medidor de una unidad falla, esa
  unidad reporta `value_kw=None`. Las demás unidades siguen normales — un
  meter caído no contagia al resto.
- Combina (`sum` para GEC3 con sus 2 medidores, `single` para los demás) y
  aplica `aplicar_signo` después.

`src/sign_convention.py` — **`aplicar_signo(frontier_type, kw)`**:

- Función pura: `'input'` invierte, `'output'` pasa tal cual, normaliza
  `-0.0 → +0.0`.
- Usada tanto por `MeterPoller` como por tests directos.

`src/config.py` — **topología y validación**:

- Define `UNITS` con id, label, max_mw, frontier_type, combine, meters[].
- Validación **fail-fast** al importar: si falta cualquier IP/PSW/USER de
  medidor, levanta `ValueError` con la lista **completa** de variables
  faltantes.
- Saltable con `CONFIG_SKIP_VALIDATION=1` para tests/herramientas.

### 2. Capa de escritura (Fabric)

`src/fabric_writer.py` — **`FabricWriter`**:

- Cliente Delta usando `deltalake` (delta-rs) — sin Spark, sin Java.
- Path OneLake: `abfss://{workspace}@onelake.dfs.fabric.microsoft.com/{lakehouse}.Lakehouse/Tables/{schema?}/{table}`.
- **Detección automática GUID vs displayName**: si `lakehouse_name` matchea
  un UUID, omite el sufijo `.Lakehouse` (necesario en tenants con
  `FriendlyNameSupportDisabled`). Si es un nombre, lo agrega.
- **Cache de tokens por scope** — los scopes son distintos:
  - `https://storage.azure.com/.default` para writes a OneLake.
  - `https://api.fabric.microsoft.com/.default` para listar lakehouses /
    refresh del SQL endpoint.
  - Cache propio con margen de 60 s antes de expirar (encima del cache de
    `azure-identity` que ya hace lo suyo).
- **Métodos**:
  - `write_overwrite(rows)` — Arrow Table con schema explícito → `write_deltalake`
    con `mode='overwrite'` + `schema_mode='overwrite'`.
  - `vacuum(retain_hours=0)` — limpia archivos físicos viejos del Delta log.
  - `refresh_sql_endpoint(id)` — best-effort POST `/refreshMetadata`. Nunca lanza.

`build_row(units_payload, now_bogota)`:

- Construye la fila Fabric a partir del output del `MeterPoller`.
- Mapping de id de unidad → columna: `TGJ1→tgj1`, `TGJ2→tgj2`, `GEC3→gec3`,
  **`GEC32→ge32`** (sin C, histórico).
- Unidades con `value_kw=None` se persisten como `0.0`.

`now_bogota_utc5()`:

- Devuelve un `datetime` en zona Bogotá (UTC−5, sin DST). Usa offset fijo
  para evitar dependencia de `tzdata` en Windows.

### 3. Loop principal (servicio continuo)

`src/service.py` — **`FabricMeterSinkService`**:

Una iteración del loop:

1. `units = poller.poll()` — paralelo, 4-5 s en peor caso.
2. Si al menos una unidad reportó valor, `build_row(...)` y push al buffer.
   Si todas dieron `None`, no hay push (loggea WARN/ERROR).
3. `writer.write_overwrite(list(buffer))` — escribe el buffer completo.
4. Cada 60 s, refresh del SQL endpoint (best-effort).
5. Cada 3 h, dispatch de VACUUM en thread separado (no bloquea el loop).
6. `Path.touch` al `HEARTBEAT_PATH`.
7. Sleep `max(0, 15 - elapsed)` — drift compensation.

`src/main.py` — **entry point** (`python -m src.main`):

- Inyecta `truststore` ANTES de cualquier import SSL — para usar el almacén
  de certificados del SO (donde IT instala la CA del proxy corporativo).
- Setup logging: stdout (capturado por systemd) + `RotatingFileHandler` 10 MB × 5.
- Construye `MeterPoller`, `FabricWriter`, `FabricMeterSinkService`.
- Instala signal handlers SIGINT/SIGTERM → `service.stop()`.
- **Watchdog de shutdown**: `threading.Timer(SHUTDOWN_TIMEOUT_S=30)` que
  fuerza `os._exit(1)` si el shutdown se cuelga (típicamente por write a
  Fabric bloqueado en I/O).
- En el `finally`: `service.flush()` (último write del buffer) + `poller.close()`.

## Schema de la tabla Delta

| Columna     | Tipo    | Descripción                                            |
|-------------|---------|--------------------------------------------------------|
| `id_date`   | int64   | YYYYMMDD                                               |
| `hourx`     | int64   | 0-23 (Bogotá UTC−5)                                    |
| `minutex`   | int64   | 0-59                                                   |
| `secondx`   | int64   | 0-59                                                   |
| `tgj1`      | float64 | TGJ1 en kW                                             |
| `tgj2`      | float64 | TGJ2 en kW                                             |
| `gec3`      | float64 | GEC3 en kW (signo invertido aplicado, suma de 2 meters)|
| `ge32`      | float64 | GEC32 en kW (signo invertido) — ⚠️ sin C, histórico    |
| `uom`       | string  | `"KW"` constante                                       |
| `descript`  | string  | `"Potencia"` constante                                 |
| `ts_concat` | int64   | YYYYMMDDhhmmss (ordenable como int)                    |

Una unidad sin dato escribe `0.0` (no NaN, no NULL — el report Power BI
espera numéricos).

## Variables de entorno

Todas leídas desde `fabric-meter-sink/.env` (cargado por `python-dotenv` al
importar `src.config`). En producción, `EnvironmentFile=` del unit de systemd
las inyecta al proceso.

### Medidores (5 IPs + 1 user + 5 passwords)

| Var | Descripción |
|---|---|
| `USER_MEDIDORES` | Usuario único compartido (típicamente `user1`) |
| `IP_TGJ1`, `IP_TGJ2`, `IP_GEC32`, `IP_GEC3_1`, `IP_GEC3_2` | Hosts/IPs |
| `PSW_TGJ1`, `PSW_TGJ2`, `PSW_GEC32`, `PSW_GEC3_1`, `PSW_GEC3_2` | Passwords |
| `METER_OP_PATH` | Path del endpoint (default `/Operation.html`) |
| `METER_TIMEOUT_S` | Timeout por request (default `4`) |

### Fabric

| Var | Descripción |
|---|---|
| `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` | Service Principal Azure AD |
| `FABRIC_WORKSPACE_ID` | GUID del workspace |
| `FABRIC_LAKEHOUSE_NAME` | GUID o displayName del Lakehouse (el cliente detecta) |
| `FABRIC_LAKEHOUSE_SCHEMA` | `dbo` o vacío si el LH no tiene schemas |
| `FABRIC_TABLE_NAME` | `BRC_PGN_GENERACION_MEDIDORES` |
| `FABRIC_SQL_ENDPOINT_ID` | GUID del SQL Analytics Endpoint (vacío para saltar refresh) |

### Loop / scheduling

| Var | Default | Descripción |
|---|---|---|
| `POLL_INTERVAL_S` | `15` | Segundos entre ciclos |
| `BUFFER_SIZE` | `3` | Filas mantenidas en el buffer rotativo |
| `VACUUM_INTERVAL_S` | `10800` | 3 h |
| `VACUUM_RETAIN_HOURS` | `0` | Limpia agresivamente, igual que el notebook |
| `REFRESH_INTERVAL_S` | `60` | Refresh SQL endpoint cada 60 s |
| `MAX_CONSECUTIVE_WRITE_FAILURES` | `5` | Antes de exit 1 |
| `SHUTDOWN_TIMEOUT_S` | `30` | Watchdog del shutdown |

### Logs / heartbeat

| Var | Default | Descripción |
|---|---|---|
| `HEARTBEAT_PATH` | `/var/run/fabric-meter-sink/heartbeat` (Linux) o `./var/heartbeat` (Windows) | Archivo touch'd cada ciclo |
| `LOG_DIR` | `./logs` | Logs rotativos (10 MB × 5) |
| `LOG_LEVEL` | `INFO` | INFO / WARNING / ERROR |

### Toggle de validación

| Var | Descripción |
|---|---|
| `CONFIG_SKIP_VALIDATION` | `=1` salta la validación fail-fast (tests, scripts ad-hoc) |

## Setup local (development)

```powershell
cd fabric-meter-sink
python -m venv .venv
. .venv/Scripts/Activate.ps1
pip install -e ".[dev]"
copy .env.example .env
# editar .env con credenciales reales
```

## Probes (validación incremental)

Tres probes de menor a mayor scope:

```powershell
# 1. Confirmar que los 5 medidores responden y los signos son correctos
python scripts/probe_meters.py

# 2. Listar items del workspace Fabric (Lakehouses, SQLEndpoints, Notebooks, etc.)
#    Útil para encontrar el GUID exacto del Lakehouse y del SQL endpoint
python scripts/probe_workspace.py

# 3. Validar end-to-end: escribe 1 fila dummy a la tabla Delta y la lee de vuelta
python scripts/probe_fabric.py
```

`probe_fabric.py` reintenta automáticamente sin schema si el path con `/dbo/`
falla con "table not found" — descubre empíricamente si el Lakehouse tiene
schemas habilitados.

## Tests

```powershell
pytest -v
ruff check src tests scripts
```

42 tests, ~2 s. **No** necesitan medidores reales ni credenciales Fabric:

- `test_meter_client.py` (20 tests) — parser con fixture HTML real, mocks
  de `httpx.MockTransport` para 200/401/500/timeout/format errors.
- `test_sign_convention.py` (10 tests) — función pura + integración con
  poller, incluye `−0 → 0`, suma+invertir GEC3 (398.05+347.01 = −745.06).
- `test_service.py` (12 tests) — loop con `FakePoller`/`FakeWriter`:
  buffer rotativo, fila con `0.0` cuando hay None, dispatch de VACUUM,
  shutdown limpio, escalación a exit 1, drift compensation.

La escritura real a Fabric **no** se mockea — validación end-to-end es
manual vía `probe_fabric.py` con credenciales reales.

## Despliegue Linux con systemd

Runbook detallado en `DEPLOY.md` (gitignored — pedírselo al implementador).
Resumen:

```bash
# 1. Copiar código a /opt/
sudo rsync -av --exclude '.venv' --exclude 'logs' --exclude 'var' --exclude '.env' \
    /var/www/dashboard-gen/fabric-meter-sink/ /opt/fabric-meter-sink/

# 2. Crear /opt/fabric-meter-sink/.env con credenciales reales (chmod 640)

# 3. Correr el instalador idempotente
sudo /opt/fabric-meter-sink/deploy/install.sh

# 4. Iniciar y validar
sudo systemctl start fabric-meter-sink
sudo journalctl -u fabric-meter-sink -f
```

`install.sh` valida pre-reqs (root, Python ≥3.10, `.env` presente), crea el
usuario de sistema `fabric-sink`, el venv, los directorios runtime, y
registra el unit de systemd.

### Pre-requisito: NTP sincronizado

El timestamp de cada fila viene del reloj del server. Si el server está
desfasado vs UTC real, las filas también lo están. Verificar con
`timedatectl` que diga `System clock synchronized: yes`. En servers detrás
de firewall corporativo, los NTP servers internacionales (`ntp.ubuntu.com`,
`time.windows.com`) suelen estar bloqueados — usar `pool.ntp.org` (que
resuelve a IPs locales).

`/etc/systemd/timesyncd.conf`:

```
[Time]
NTP=pool.ntp.org
FallbackNTPServers=0.pool.ntp.org 1.pool.ntp.org 2.pool.ntp.org 3.pool.ntp.org
```

Después: `sudo systemctl restart systemd-timesyncd`.

### Pre-requisito: CA del proxy corporativo

`truststore` (ya integrado) levanta del store del SO. En Linux, el almacén
está en `/etc/ssl/certs/`. Si IT no instaló la CA corporativa allí, el
write a Fabric falla con `[SSL: CERTIFICATE_VERIFY_FAILED]`. Fix:

```bash
sudo cp corp-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

## Operación

| Acción | Comando |
|---|---|
| Start | `sudo systemctl start fabric-meter-sink` |
| Stop | `sudo systemctl stop fabric-meter-sink` |
| Restart | `sudo systemctl restart fabric-meter-sink` |
| Status | `systemctl status fabric-meter-sink` |
| Logs en vivo | `sudo journalctl -u fabric-meter-sink -f` |
| Últimas N líneas | `sudo journalctl -u fabric-meter-sink -n 200 --no-pager` |
| Heartbeat | `stat /var/run/fabric-meter-sink/heartbeat` (debe actualizar cada ~15 s) |
| Logs en disco | `sudo ls -lh /opt/fabric-meter-sink/logs/` |

### Actualizar el código

```bash
cd /var/www/dashboard-gen && sudo git pull
sudo rsync -av --delete \
    --exclude '.venv' --exclude '__pycache__' --exclude '.pytest_cache' \
    --exclude 'logs' --exclude 'var' --exclude '.env' \
    /var/www/dashboard-gen/fabric-meter-sink/ /opt/fabric-meter-sink/
sudo /opt/fabric-meter-sink/.venv/bin/pip install --quiet -e /opt/fabric-meter-sink
sudo systemctl restart fabric-meter-sink
```

## Resiliencia y auto-recuperación

Tres capas de retries / restart apilados — recupera solo de la mayoría de
fallas, sin intervención humana.

### Capa 1 — Retry por ciclo (en proceso)

Cada 15 s. Si el write falla, log ERROR y siguiente ciclo retry. Cubre el
99 % de fallas: blip de red, 5xx transitorio, token cerca de expirar.

### Capa 2 — Escalación a exit 1

Después de `MAX_CONSECUTIVE_WRITE_FAILURES=5` (≈75 s sin un write OK), el
proceso sale con código 1. Limpia cualquier estado corrupto en memoria.

### Capa 3 — Auto-restart por systemd

`Restart=always` + `RestartSec=10`. systemd vuelve a levantar el proceso
10 s después de cualquier exit. `systemctl enable` arranca al boot.

### Línea de tiempo de un outage

```
00:00  Outage Fabric empieza. Servicio estaba escribiendo OK.
00:15  Cycle N → write FAIL (1)
...
01:15  Cycle N+4 → write FAIL (5) → exit 1
01:25  systemd reinicia (RestartSec=10)
01:25  Servicio arranca, buffer vacío
01:40  Cycle 1 → write FAIL (1)
... mismo patrón cada 85 s ...
30:00  Outage termina, Fabric responde
30:15  Cycle X → write OK ✓
```

**Sin intervención manual.** El buffer en memoria se pierde en cada restart
pero `overwrite` con el siguiente ciclo válido lleva la tabla a estado
correcto.

### Escenarios concretos

| Falla | Detección | Recuperación | Pérdida de datos |
|---|---|---|---|
| Blip red (1-2 ciclos) | Write timeout | Retry next cycle | Ninguna |
| Fabric API 5xx transitorio | Excepción | Retry next cycle | Ninguna |
| Fabric outage largo (horas) | 5 fallos → exit 1 | Cycle: exit→restart→retry hasta que vuelva | Ninguna persistente |
| Token expira (~1 h) | n/a | `azure-identity` lo refresca solo | Ninguna |
| **Credenciales revocadas** | 401 persistente | **Loop infinito 401** — requiere intervención manual | Tabla congelada |
| **Permisos revocados (403)** | 403 persistente | Igual al anterior | Tabla congelada |
| SQL endpoint refresh falla | HTTP 404/etc. | Best-effort, log warn, sigue (Fabric sync de fondo igual sincroniza) | Ninguna |
| VACUUM falla | Excepción en thread | Best-effort, log warn, sigue | Ninguna |
| 1 medidor cae | `value_kw=None` | Esa unidad escribe `0.0`, otras siguen | 0.0 mientras dure |
| Todos los medidores caen | Todos `value_kw=None` | No push al buffer, no write | Ninguna a Fabric |
| Server reboot | n/a | systemd levanta al boot (`enabled`) | Ninguna |
| Process segfault / OOM | Exit code != 0 | systemd restart en 10 s | Ninguna |
| `.env` corrupto | Validación fail-fast | Restart loop hasta que se arregle | Requiere intervención |

### Lo único que NO se auto-recupera

1. **Credenciales revocadas o vencidas** (CLIENT_SECRET).
2. **Service principal pierde permisos** del workspace (403).
3. **`.env` con valores incorrectos** (typo en GUID, etc.).

Patrón en los tres casos: arreglar `.env` o re-otorgar permisos en Azure →
`sudo systemctl restart fabric-meter-sink`.

### Monitoreo en producción

Tres señales independientes:

```bash
# 1. ¿El proceso vive?
systemctl is-active fabric-meter-sink     # → "active"

# 2. ¿El loop está girando? (heartbeat actualizado en último minuto)
find /var/run/fabric-meter-sink/heartbeat -mmin -1   # debe imprimir el path

# 3. ¿Está escribiendo a Fabric? (log de "wrote ... rows" en últimos 2 min)
sudo journalctl -u fabric-meter-sink --since "2 min ago" | grep "wrote .* rows to Fabric"
```

Las tres juntas como alerta: **active** + **heartbeat fresco** + **NO logs
de "wrote ... rows"** durante varios minutos seguidos → algo está mal con
Fabric/credenciales y necesita intervención.

## Métricas operacionales

- **Cadencia**: 15 s (`POLL_INTERVAL_S`).
- **Volumen**: 5760 ciclos/día = 5760 writes a Fabric/día.
- **VACUUM**: cada 3 h, retain 0 horas (limpia agresivamente).
- **Refresh SQL endpoint**: cada 60 s, best-effort.
- **Buffer en memoria**: 3 filas (overwrite, no append).
- **Polling per-medidor**: ~4 req/min/medidor desde este servicio
  (también el dashboard Node polea cada 2 s ⇒ ~30 req/min/medidor extra; los
  ION8650 toleran sin problema).

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| Medidor caído (log warn con host) | Red, credenciales, firmware | Poller reporta `None` → fila escribe `0.0`; chequear con `probe_meters.py` |
| Write a Fabric falla esporádicamente | Token expirado / red intermitente | Retry next cycle automático; escala a exit 1 después de 5 fallos consecutivos |
| HTTP 401 al obtener token | TENANT_ID / CLIENT_ID / CLIENT_SECRET mal copiados en `.env` | Revisar `.env` |
| HTTP 403 al escribir | Service principal no es Contributor del workspace | Revisar Fabric Admin; settings tardan 15-30 min en propagar |
| `FriendlyNameSupportDisabled` | Tenant exige GUIDs en path, no displayNames | Poner `FABRIC_LAKEHOUSE_NAME` con el GUID (ver `probe_workspace.py`) |
| `[SSL: CERTIFICATE_VERIFY_FAILED]` | Proxy corporativo intercepta TLS | `truststore` ya usa el store del SO; si la CA no está, instalarla con `update-ca-certificates` |
| `ItemNotFound` en refresh SQL endpoint | `FABRIC_SQL_ENDPOINT_ID` apunta al GUID del lakehouse en lugar del SQL endpoint | Listar items con `probe_workspace.py`, copiar el GUID del item tipo `SQLEndpoint` |
| `CommitFailedError: a concurrent transaction deleted data` | Dos procesos escribiendo a la misma tabla Delta | Asegurar que solo UN escritor corre a la vez. Síntoma típico cuando coexisten el notebook viejo y este servicio |
| "Table not found" / path inválido | Lakehouse sin schemas | `probe_fabric.py` reintenta sin schema y avisa; en `.env` dejar `FABRIC_LAKEHOUSE_SCHEMA=` vacío |
| Schema mismatch al primer write | Tabla pre-existe con tipos distintos | `write_overwrite` usa `schema_mode='overwrite'`, debería resolverlo |
| Heartbeat no se actualiza | Proceso colgado en I/O remoto | systemd reinicia con `Restart=always`; investigar logs |
| VACUUM falla | Conflicto con writers concurrentes | Log warn, continúa; no fatal |
| Filas con timestamp desfasado | Reloj del server no sincronizado | Configurar timesyncd con `pool.ntp.org` (`time.windows.com`/`ntp.ubuntu.com` suelen estar bloqueados por firewall) |
| `command not found` al ejecutar `install.sh` | Line endings CRLF (Windows) | `sudo sed -i 's/\r$//' install.sh && sudo chmod +x install.sh` |
| `ensurepip is not available` | Falta paquete python3-venv en Ubuntu | `sudo apt install -y python3.12-venv` (o version equivalente) |

## Migración del notebook viejo

Una vez validado el servicio nuevo en producción durante 24 h:

1. **No** apagar el notebook todavía. Validar con SQL queries que la tabla
   refleja cadencia de 15 s (timestamps cada 15 s, no cada 5 min).
2. Apagar el schedule del notebook en Fabric (UI → Workspace → notebook →
   Settings → Schedules → Disable). **No borrarlo**.
3. Si todo bien por 1 semana, archivar/borrar.

> Si los dos procesos corren simultáneamente, ambos pisan la misma tabla en
> cadencias distintas y aparece `CommitFailedError: a concurrent transaction
> deleted data this operation read`. Si lo ves, identificá quién está
> compitiendo y matalo antes de seguir.

Si el servicio nuevo falla, reactivar el schedule del notebook es el
rollback rápido.

## Notas

- **Aislamiento total respecto al dashboard Node**: distinto pyproject,
  distinto venv, distinto despliegue (`/opt/fabric-meter-sink/` vs
  `/var/www/dashboard-gen/`). Sólo comparten el `.env` a nivel de credenciales
  de medidores duplicadas.
- **Tokens Azure por scope**: el token para OneLake (`storage.azure.com`) y
  el de la API REST de Fabric (`api.fabric.microsoft.com`) son distintos. El
  `FabricWriter` cachea ambos por separado.
- **Optimización futura opcional**: este servicio podría ser un cliente
  WebSocket del dashboard Node (`ws://localhost:3001`) en lugar de polear
  directo a los medidores — pero rompe el aislamiento que se pidió. Por
  ahora cada uno polea independiente.
- **Nombre `BRC_PGN_GENERACION_MEDIDORES`**: suena a tabla de prueba pero es la
  que usa el report en producción. No cambiar.
