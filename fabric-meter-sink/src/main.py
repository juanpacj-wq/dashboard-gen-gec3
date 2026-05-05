"""Entry point CLI del servicio: `python -m src.main`.

Carga config (que ya carga `.env`), arma logging (stdout + RotatingFileHandler),
construye `MeterPoller` + `FabricWriter` + `FabricMeterSinkService`, instala
handlers de SIGINT/SIGTERM y corre el loop. En el `finally` ejecuta el
`flush()` final del buffer.

Si la salida normal del loop fue por `MAX_CONSECUTIVE_WRITE_FAILURES`, retorna
exit code 1 — systemd reinicia automáticamente con `Restart=always`.
"""

from __future__ import annotations

# truststore tiene que cargarse ANTES que cualquier librería que use SSL para
# que use el almacén de certificados del SO (donde IT instala la CA del proxy
# corporativo).
import truststore

truststore.inject_into_ssl()

import logging  # noqa: E402
import logging.handlers  # noqa: E402
import os  # noqa: E402
import signal  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
from pathlib import Path  # noqa: E402

from src import config  # noqa: E402
from src.fabric_writer import FabricWriter  # noqa: E402
from src.meter_poller import MeterPoller  # noqa: E402
from src.service import FabricMeterSinkService  # noqa: E402

LOG_FORMAT = "[%(asctime)s] %(levelname)-5s %(name)s — %(message)s"
LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"


def setup_logging(log_dir: str, level: str) -> None:
    """Stdout (capturado por systemd) + archivo rotativo 10 MB × 5."""
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    log_file = Path(log_dir) / "fabric-meter-sink.log"

    formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATEFMT)

    root = logging.getLogger()
    root.setLevel(getattr(logging, level, logging.INFO))
    root.handlers.clear()

    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.addHandler(stream)

    rotating = logging.handlers.RotatingFileHandler(
        log_file,
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    rotating.setFormatter(formatter)
    root.addHandler(rotating)

    # azure-identity y httpx tienden a ser ruidosos en INFO.
    logging.getLogger("azure").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def _ensure_dir(path: Path, log: logging.Logger) -> None:
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.warning("no se pudo crear directorio %s: %s — el servicio sigue", path, exc)


def main() -> int:
    setup_logging(config.LOG_DIR, config.LOG_LEVEL)
    log = logging.getLogger("fabric-meter-sink")
    log.info("Fabric Meter Sink — starting")

    _ensure_dir(Path(config.LOG_DIR), log)
    _ensure_dir(Path(config.HEARTBEAT_PATH).parent, log)

    poller = MeterPoller(
        units=config.UNITS,
        timeout_s=config.METER_DEFAULTS["timeout_s"],
        op_path=config.METER_DEFAULTS["op_path"],
    )
    writer = FabricWriter(
        tenant_id=config.TENANT_ID,
        client_id=config.CLIENT_ID,
        client_secret=config.CLIENT_SECRET,
        workspace_id=config.FABRIC_WORKSPACE_ID,
        lakehouse_name=config.FABRIC_LAKEHOUSE_NAME,
        table_name=config.FABRIC_TABLE_NAME,
        schema=config.FABRIC_LAKEHOUSE_SCHEMA,
    )
    service = FabricMeterSinkService(
        poller=poller,
        writer=writer,
        sql_endpoint_id=config.FABRIC_SQL_ENDPOINT_ID,
        poll_interval_s=config.POLL_INTERVAL_S,
        buffer_size=config.BUFFER_SIZE,
        vacuum_interval_s=config.VACUUM_INTERVAL_S,
        vacuum_retain_hours=config.VACUUM_RETAIN_HOURS,
        refresh_interval_s=config.REFRESH_INTERVAL_S,
        heartbeat_path=config.HEARTBEAT_PATH,
        max_consecutive_write_failures=config.MAX_CONSECUTIVE_WRITE_FAILURES,
    )

    # Watchdog de shutdown: si pasados SHUTDOWN_TIMEOUT_S del primer SIGTERM
    # el proceso sigue vivo, forzar salida (no podemos confiar en threads
    # bloqueados en I/O remoto a Fabric).
    shutdown_timer: threading.Timer | None = None

    def _force_exit() -> None:
        log.error("shutdown timeout (%ds) excedido — forzando salida", config.SHUTDOWN_TIMEOUT_S)
        os._exit(1)

    def shutdown_handler(signum: int, _frame: object) -> None:
        nonlocal shutdown_timer
        log.info("recibida señal %d, iniciando shutdown limpio", signum)
        service.stop()
        if shutdown_timer is None:
            shutdown_timer = threading.Timer(config.SHUTDOWN_TIMEOUT_S, _force_exit)
            shutdown_timer.daemon = True
            shutdown_timer.start()

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    exit_code = 0
    try:
        exit_code = service.run()
    except Exception:
        log.exception("Service crashed unexpectedly")
        exit_code = 1
    finally:
        try:
            service.flush()
        except Exception:
            log.exception("error durante flush final")
        try:
            poller.close()
        except Exception:
            pass
        if shutdown_timer is not None:
            shutdown_timer.cancel()
        log.info("Fabric Meter Sink — stopped (exit_code=%d)", exit_code)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
