"""Loop principal: poll medidores → buffer rotativo → write a Fabric Delta.

Cadencia y semántica resumida:

- Poll a 5 medidores cada `poll_interval_s` (default 15 s).
- Buffer rotativo `deque(maxlen=buffer_size)` con las últimas N filas.
- Cada poll exitoso (≥1 unidad con `value_kw is not None`) hace push al buffer
  con `0.0` para las unidades fallidas.
- Cada ciclo (después del poll) escribe el buffer **completo** en modo
  `overwrite` — la tabla siempre refleja los últimos N registros.
- VACUUM cada `vacuum_interval_s` (default 3 h, retain 0) en thread separado.
- Refresh del SQL endpoint cada `refresh_interval_s` (default 60 s), best-effort.
- Heartbeat: `Path.touch` al `heartbeat_path` cada ciclo.

Drift: el sleep entre ciclos es `poll_interval_s - elapsed`, no `poll_interval_s`
crudo, para mantener cadencia regular incluso si un ciclo se demoró 2-3 s.

Shutdown: `stop()` setea un `threading.Event`. El sleep usa `event.wait(timeout)`
así que un SIGTERM aborta el sleep inmediatamente. `flush()` escribe una última
vez el buffer; lo llama `main.py` en el `finally`.
"""

from __future__ import annotations

import collections
import logging
import threading
import time
from pathlib import Path
from typing import Any

from .fabric_writer import build_row, now_bogota_utc5

logger = logging.getLogger(__name__)


class FabricMeterSinkService:
    def __init__(
        self,
        *,
        poller: Any,
        writer: Any,
        sql_endpoint_id: str | None = None,
        poll_interval_s: float = 15.0,
        buffer_size: int = 3,
        vacuum_interval_s: int = 10800,
        vacuum_retain_hours: int = 0,
        refresh_interval_s: int = 60,
        heartbeat_path: str | Path = "/var/run/fabric-meter-sink/heartbeat",
        max_consecutive_write_failures: int = 5,
    ) -> None:
        self.poller = poller
        self.writer = writer
        self.sql_endpoint_id = sql_endpoint_id
        self.poll_interval_s = float(poll_interval_s)
        self.buffer_size = int(buffer_size)
        self.vacuum_interval_s = int(vacuum_interval_s)
        self.vacuum_retain_hours = int(vacuum_retain_hours)
        self.refresh_interval_s = int(refresh_interval_s)
        self.heartbeat_path = Path(heartbeat_path)
        self.max_consecutive_write_failures = int(max_consecutive_write_failures)

        self.buffer: collections.deque[dict] = collections.deque(maxlen=self.buffer_size)
        self._stop_evt = threading.Event()
        self._cycle = 0
        # Nunca disparar VACUUM/refresh en el primer ciclo: dar al menos 1 ventana.
        self._last_vacuum_t = time.monotonic()
        self._last_refresh_t = time.monotonic()
        self._consecutive_write_failures = 0
        self._consecutive_empty_polls = 0
        self._heartbeat_warned = False
        self._vacuum_thread: threading.Thread | None = None
        self.exit_code = 0

    def stop(self) -> None:
        self._stop_evt.set()

    def run(self) -> int:
        logger.info(
            "FabricMeterSinkService starting (poll=%.1fs buffer=%d max_fail=%d)",
            self.poll_interval_s, self.buffer_size, self.max_consecutive_write_failures,
        )
        while not self._stop_evt.is_set():
            cycle_start = time.monotonic()
            self._cycle += 1
            try:
                self._run_one_cycle()
            except Exception:
                # Defensa en profundidad: un cycle no debería lanzar (todo está
                # protegido), pero si pasa, no matar el loop.
                logger.exception("unexpected error in cycle %d", self._cycle)

            if self._consecutive_write_failures >= self.max_consecutive_write_failures:
                logger.error(
                    "max consecutive write failures reached (%d) — exiting con código 1",
                    self._consecutive_write_failures,
                )
                self.exit_code = 1
                break

            elapsed = time.monotonic() - cycle_start
            sleep_for = self._sleep_duration(elapsed)
            if sleep_for > 0 and self._stop_evt.wait(timeout=sleep_for):
                break

        logger.info(
            "FabricMeterSinkService loop exited (cycle=%d, exit_code=%d)",
            self._cycle, self.exit_code,
        )
        return self.exit_code

    def flush(self) -> None:
        """Último write del buffer antes de salir. Llamado en el finally de main.py."""
        if not self.buffer:
            logger.info("flush: buffer vacío, nada que escribir")
            return
        logger.info("flush: writing final buffer (%d rows)", len(self.buffer))
        try:
            self.writer.write_overwrite(list(self.buffer))
            logger.info("flush: OK")
        except Exception:
            logger.exception("flush failed")

    def _run_one_cycle(self) -> None:
        units = self.poller.poll()
        has_any = any(u.get("value_kw") is not None for u in units)

        if has_any:
            self._consecutive_empty_polls = 0
            row = build_row(units, now_bogota_utc5())
            self.buffer.append(row)
        else:
            self._consecutive_empty_polls += 1
            if self._consecutive_empty_polls >= 2:
                logger.error(
                    "cycle %d: %d ciclos seguidos sin dato de NINGUNA unidad",
                    self._cycle, self._consecutive_empty_polls,
                )
            else:
                logger.warning("cycle %d: ninguna unidad reportó valor", self._cycle)

        write_ok = True
        if self.buffer:
            try:
                self.writer.write_overwrite(list(self.buffer))
                self._consecutive_write_failures = 0
            except Exception as exc:
                self._consecutive_write_failures += 1
                logger.error(
                    "cycle %d: write a Fabric falló (%d consecutivos): %s: %s",
                    self._cycle, self._consecutive_write_failures,
                    type(exc).__name__, exc,
                    exc_info=True,
                )
                write_ok = False

        # Resumen del ciclo (1 línea, formato spec)
        parts = [f"cycle={self._cycle}"]
        for u in units:
            value = u.get("value_kw")
            value_str = "None" if value is None else f"{value:.1f}"
            parts.append(f"{u.get('id')}={value_str}")
        if not self.buffer:
            parts.append("(buffer vacío, no se escribió)")
        elif write_ok:
            parts.append(f"→ wrote {len(self.buffer)} rows to Fabric")
        else:
            parts.append("→ write FAILED")
        logger.info(" ".join(parts))

        self._maybe_refresh()
        self._maybe_vacuum()
        self._heartbeat()

    def _sleep_duration(self, cycle_elapsed_s: float) -> float:
        """Compensa drift: si el ciclo tomó X s, el próximo sleep es interval-X."""
        return max(0.0, self.poll_interval_s - cycle_elapsed_s)

    def _maybe_refresh(self) -> None:
        if not self.sql_endpoint_id:
            return
        if time.monotonic() - self._last_refresh_t < self.refresh_interval_s:
            return
        self._last_refresh_t = time.monotonic()
        # Best-effort, nunca lanza (FabricWriter.refresh_sql_endpoint atrapa todo).
        ok = self.writer.refresh_sql_endpoint(self.sql_endpoint_id)
        if not ok:
            logger.warning("cycle %d: refresh SQL endpoint devolvió False", self._cycle)

    def _maybe_vacuum(self) -> None:
        if time.monotonic() - self._last_vacuum_t < self.vacuum_interval_s:
            return
        if self._vacuum_thread is not None and self._vacuum_thread.is_alive():
            # Aún corriendo el VACUUM previo; no superponer.
            return
        self._last_vacuum_t = time.monotonic()
        logger.info("dispatching VACUUM en thread separado (retain=%d h)", self.vacuum_retain_hours)
        thread = threading.Thread(
            target=self._run_vacuum,
            name="vacuum",
            daemon=True,
        )
        self._vacuum_thread = thread
        thread.start()

    def _run_vacuum(self) -> None:
        try:
            count = self.writer.vacuum(retain_hours=self.vacuum_retain_hours)
            logger.info("VACUUM done: %d archivos eliminados", count)
        except Exception:
            logger.exception("VACUUM falló")

    def _heartbeat(self) -> None:
        try:
            self.heartbeat_path.touch(exist_ok=True)
        except OSError as exc:
            # No matar el loop por un heartbeat caído (filesystem RO, permisos, etc.).
            # Loggear sólo la primera vez para no inundar.
            if not self._heartbeat_warned:
                logger.warning(
                    "heartbeat touch falló (%s) — loop continúa pero el monitor "
                    "externo no verá actualizaciones",
                    exc,
                )
                self._heartbeat_warned = True
