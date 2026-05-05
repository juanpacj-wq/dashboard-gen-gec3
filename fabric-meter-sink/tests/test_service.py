from __future__ import annotations

import threading
import time

import pytest

from src.service import FabricMeterSinkService

# ──────────────────────────────────────────────────────────────────────────────
# Fakes
# ──────────────────────────────────────────────────────────────────────────────


class FakePoller:
    """Devuelve resultados fijos o derivados del nro. de poll."""

    def __init__(self, results) -> None:
        self._results = results
        self.poll_count = 0

    def poll(self) -> list[dict]:
        self.poll_count += 1
        if callable(self._results):
            return self._results(self.poll_count)
        return [dict(u) for u in self._results]

    def close(self) -> None:
        pass


class FakeWriter:
    def __init__(self) -> None:
        self.write_calls: list[list[dict]] = []
        self.vacuum_calls: list[int] = []
        self.refresh_calls: list[str] = []
        self.write_should_fail = False
        self.vacuum_done_evt = threading.Event()

    def write_overwrite(self, rows: list[dict]) -> None:
        # deep-ish copy: snapshot al momento del call.
        self.write_calls.append([dict(r) for r in rows])
        if self.write_should_fail:
            raise RuntimeError("simulated write failure")

    def vacuum(self, retain_hours: int = 0) -> int:
        self.vacuum_calls.append(retain_hours)
        self.vacuum_done_evt.set()
        return 0

    def refresh_sql_endpoint(self, sql_endpoint_id: str) -> bool:
        self.refresh_calls.append(sql_endpoint_id)
        return True


def _ok_units():
    return [
        {"id": "TGJ1", "label": "GUAJIRA 1", "value_kw": 100.0,  "max_mw": 145},
        {"id": "TGJ2", "label": "GUAJIRA 2", "value_kw": 200.0,  "max_mw": 130},
        {"id": "GEC3", "label": "GECELCA 3", "value_kw": -50.0,  "max_mw": 164},
        {"id": "GEC32","label": "GECELCA 32","value_kw": -300.0, "max_mw": 270},
    ]


def _make_service(tmp_path, **overrides):
    poller = overrides.pop("poller", FakePoller(_ok_units()))
    writer = overrides.pop("writer", FakeWriter())
    defaults = {
        "poller": poller,
        "writer": writer,
        "poll_interval_s": 0.05,
        "buffer_size": 3,
        "vacuum_interval_s": 10800,
        "refresh_interval_s": 60,
        "heartbeat_path": str(tmp_path / "heartbeat"),
        "max_consecutive_write_failures": 5,
    }
    defaults.update(overrides)
    return FabricMeterSinkService(**defaults), poller, writer


# ──────────────────────────────────────────────────────────────────────────────
# 1. Un ciclo simple llena buffer y llama writer.write_overwrite
# ──────────────────────────────────────────────────────────────────────────────


def test_one_cycle_fills_buffer_and_writes(tmp_path):
    service, poller, writer = _make_service(tmp_path)
    service._run_one_cycle()

    assert poller.poll_count == 1
    assert len(service.buffer) == 1
    assert len(writer.write_calls) == 1
    row = writer.write_calls[0][0]
    assert row["tgj1"] == 100.0
    assert row["tgj2"] == 200.0
    assert row["gec3"] == -50.0
    assert row["ge32"] == -300.0  # ⚠️ sin C, histórico
    assert row["uom"] == "KW"
    assert row["descript"] == "Potencia"


# ──────────────────────────────────────────────────────────────────────────────
# 2. Buffer rotativo: tras 5 ciclos, write recibe sólo las últimas 3
# ──────────────────────────────────────────────────────────────────────────────


def test_rotating_buffer_keeps_last_n(tmp_path):
    def make_units(cycle_n: int):
        return [
            {"id": "TGJ1", "value_kw": float(cycle_n), "max_mw": 145},
            {"id": "TGJ2", "value_kw": 0.0, "max_mw": 130},
            {"id": "GEC3", "value_kw": 0.0, "max_mw": 164},
            {"id": "GEC32", "value_kw": 0.0, "max_mw": 270},
        ]

    poller = FakePoller(make_units)
    service, _, writer = _make_service(tmp_path, poller=poller, buffer_size=3)
    for _ in range(5):
        service._run_one_cycle()

    last_write = writer.write_calls[-1]
    assert len(last_write) == 3, "buffer debe tener exactamente buffer_size filas"
    assert [r["tgj1"] for r in last_write] == [3.0, 4.0, 5.0]


# ──────────────────────────────────────────────────────────────────────────────
# 3. Una unidad con value_kw=None → fila escribe 0.0 para esa columna
# ──────────────────────────────────────────────────────────────────────────────


def test_unit_with_none_writes_zero(tmp_path):
    poller = FakePoller([
        {"id": "TGJ1", "value_kw": 100.0, "max_mw": 145},
        {"id": "TGJ2", "value_kw": None, "max_mw": 130},
        {"id": "GEC3", "value_kw": -50.0, "max_mw": 164},
        {"id": "GEC32", "value_kw": -300.0, "max_mw": 270},
    ])
    service, _, writer = _make_service(tmp_path, poller=poller)
    service._run_one_cycle()

    row = writer.write_calls[0][0]
    assert row["tgj1"] == 100.0
    assert row["tgj2"] == 0.0  # None → 0.0
    assert row["gec3"] == -50.0
    assert row["ge32"] == -300.0


# ──────────────────────────────────────────────────────────────────────────────
# 4. VACUUM se dispara cuando se cumple el intervalo
# ──────────────────────────────────────────────────────────────────────────────


def test_vacuum_dispatched_when_interval_elapsed(tmp_path):
    service, _, writer = _make_service(tmp_path, vacuum_interval_s=0)
    # Forzar que parezca pasado (ya está =0 pero hacemos explícito):
    service._last_vacuum_t = time.monotonic() - 999

    service._run_one_cycle()
    # VACUUM corre en thread; esperar hasta que finalice o timeout.
    assert writer.vacuum_done_evt.wait(timeout=2.0)
    assert len(writer.vacuum_calls) == 1


# ──────────────────────────────────────────────────────────────────────────────
# 5. stop() termina el loop limpiamente y un flush() posterior persiste el buffer
# ──────────────────────────────────────────────────────────────────────────────


def test_stop_returns_quickly_and_flush_writes(tmp_path):
    service, _, writer = _make_service(tmp_path, poll_interval_s=0.05)

    thread = threading.Thread(target=service.run, name="loop")
    thread.start()
    time.sleep(0.15)  # dejar correr 2-3 ciclos
    started = time.monotonic()
    service.stop()
    thread.join(timeout=2.0)
    elapsed = time.monotonic() - started

    assert not thread.is_alive(), "el loop no terminó tras stop()"
    assert elapsed < 1.0, f"shutdown tardó {elapsed:.2f}s, > 1s"
    writes_before_flush = len(writer.write_calls)
    service.flush()
    assert len(writer.write_calls) == writes_before_flush + 1


# ──────────────────────────────────────────────────────────────────────────────
# 6. Write a Fabric falla N veces seguidas → loop sale con exit_code=1
# ──────────────────────────────────────────────────────────────────────────────


def test_max_consecutive_write_failures_exits_with_code_1(tmp_path):
    writer = FakeWriter()
    writer.write_should_fail = True
    service, _, _ = _make_service(
        tmp_path,
        writer=writer,
        poll_interval_s=0.001,
        max_consecutive_write_failures=3,
    )
    exit_code = service.run()
    assert exit_code == 1
    assert service._consecutive_write_failures >= 3


# ──────────────────────────────────────────────────────────────────────────────
# 7. Drift compensation: ciclo lento → próximo sleep se acorta
# ──────────────────────────────────────────────────────────────────────────────


def test_drift_compensation_shortens_sleep(tmp_path):
    service, _, _ = _make_service(tmp_path)
    service.poll_interval_s = 15.0

    assert service._sleep_duration(0.0) == 15.0
    assert service._sleep_duration(3.0) == 12.0  # 15 - 3
    assert service._sleep_duration(15.0) == 0.0
    assert service._sleep_duration(20.0) == 0.0  # ciclo más largo que el intervalo


# ──────────────────────────────────────────────────────────────────────────────
# 8. Edge case: si todas las unidades dan None, no se hace push al buffer
# ──────────────────────────────────────────────────────────────────────────────


def test_all_units_none_does_not_push(tmp_path):
    poller = FakePoller([
        {"id": "TGJ1", "value_kw": None, "max_mw": 145},
        {"id": "TGJ2", "value_kw": None, "max_mw": 130},
        {"id": "GEC3", "value_kw": None, "max_mw": 164},
        {"id": "GEC32", "value_kw": None, "max_mw": 270},
    ])
    service, _, writer = _make_service(tmp_path, poller=poller)
    service._run_one_cycle()

    assert len(service.buffer) == 0
    # buffer vacío → tampoco escribe.
    assert len(writer.write_calls) == 0
    assert service._consecutive_empty_polls == 1


# ──────────────────────────────────────────────────────────────────────────────
# 9. Heartbeat: cada ciclo toca el archivo (existe después del primer poll)
# ──────────────────────────────────────────────────────────────────────────────


def test_heartbeat_file_is_touched(tmp_path):
    hb = tmp_path / "heartbeat"
    service, _, _ = _make_service(tmp_path, heartbeat_path=str(hb))
    assert not hb.exists()
    service._run_one_cycle()
    assert hb.exists()


@pytest.mark.parametrize("elapsed,expected", [(0.0, 15.0), (5.0, 10.0), (16.0, 0.0)])
def test_drift_parametric(tmp_path, elapsed, expected):
    service, _, _ = _make_service(tmp_path, poll_interval_s=15.0)
    assert service._sleep_duration(elapsed) == expected
