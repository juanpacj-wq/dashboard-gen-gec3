from __future__ import annotations

import math

import pytest

from src.meter_poller import MeterPoller
from src.sign_convention import aplicar_signo

# ──────────────────────────────────────────────────────────────────────────────
# Función pura
# ──────────────────────────────────────────────────────────────────────────────


def test_output_passes_positive_value_unchanged():
    assert aplicar_signo("output", 72800.0) == 72800.0


def test_output_passes_negative_value_unchanged():
    # Una Guajira parada consumiendo aux puede reportar negativo en frontera output.
    assert aplicar_signo("output", -3000.0) == -3000.0


def test_input_inverts_positive_value():
    # Gecelca en reserva: medidor +740 kW → debe ser -740 kW.
    assert aplicar_signo("input", 740.0) == -740.0


def test_input_inverts_negative_value():
    # Gecelca generando: medidor -150 kW → debe ser +150 kW.
    assert aplicar_signo("input", -150.0) == 150.0


def test_negative_zero_normalizes_to_positive_zero():
    # Caso real: medidor reporta 0.00 kW exacto, frontera input → la inversión
    # produce -0.0, que debe normalizarse a +0.0 (math.copysign(1, x) == 1).
    result = aplicar_signo("input", 0.0)
    assert result == 0.0
    assert math.copysign(1.0, result) == 1.0


def test_unknown_frontier_type_passes_through_conservatively():
    # Defensa en profundidad: un frontier_type no reconocido NO invierte. La
    # validación estricta vive en config.py.
    assert aplicar_signo("lateral", 100.0) == 100.0


# ──────────────────────────────────────────────────────────────────────────────
# Integración con MeterPoller (suma + signo a nivel de unidad)
# ──────────────────────────────────────────────────────────────────────────────


class _Meter:
    def __init__(self, host: str) -> None:
        self.host = host
        self.user = "u"
        self.password = "p"


class _Unit:
    def __init__(
        self,
        unit_id: str,
        label: str,
        max_mw: int,
        frontier_type: str,
        combine: str,
        hosts: list[str],
    ) -> None:
        self.id = unit_id
        self.label = label
        self.max_mw = max_mw
        self.frontier_type = frontier_type
        self.combine = combine
        self.meters = [_Meter(h) for h in hosts]


class _FakeClient:
    def __init__(self, kw: float) -> None:
        self._kw = kw

    def fetch_kw_total(self) -> dict:
        return {"kw": self._kw, "fetched_at": "", "latency_ms": 0}

    def close(self) -> None:
        pass


@pytest.fixture
def gec3_unit():
    return _Unit("GEC3", "GECELCA 3", 164, "input", "sum", ["a", "b"])


def test_poller_input_with_sum_combines_then_inverts(gec3_unit):
    """Caso real observado: 398.05 + 347.01 = 745.06 → -745.06 (en kW)."""
    kw_by_host = {"a": 398.05, "b": 347.01}

    def factory(*, host, **_kw):
        return _FakeClient(kw_by_host[host])

    poller = MeterPoller([gec3_unit], client_factory=factory)
    try:
        results = poller.poll()
    finally:
        poller.close()

    gec3 = next(r for r in results if r["id"] == "GEC3")
    assert gec3["value_kw"] == pytest.approx(-745.06, abs=1e-6)
    assert gec3["max_mw"] == 164


def test_poller_output_keeps_meter_value():
    unit = _Unit("TGJ1", "GUAJIRA 1", 145, "output", "single", ["h1"])

    def factory(*, host, **_kw):
        return _FakeClient(72800.0)

    poller = MeterPoller([unit], client_factory=factory)
    try:
        results = poller.poll()
    finally:
        poller.close()
    assert results[0]["value_kw"] == 72800.0


def test_poller_isolates_unit_failure(gec3_unit):
    """Si UN medidor de GEC3 falla, GEC3 reporta None pero TGJ1 sigue OK."""
    tgj1 = _Unit("TGJ1", "GUAJIRA 1", 145, "output", "single", ["h_tgj"])

    def factory(*, host, **_kw):
        if host == "b":
            class Bad(_FakeClient):
                def fetch_kw_total(self):
                    raise RuntimeError("boom")
            return Bad(0)
        if host == "a":
            return _FakeClient(398.05)
        if host == "h_tgj":
            return _FakeClient(72800.0)
        raise AssertionError(f"unexpected host {host}")

    poller = MeterPoller([gec3_unit, tgj1], client_factory=factory)
    try:
        results = poller.poll()
    finally:
        poller.close()

    by_id = {r["id"]: r for r in results}
    assert by_id["GEC3"]["value_kw"] is None
    assert by_id["TGJ1"]["value_kw"] == 72800.0


def test_poller_zero_kw_normalized_to_positive_zero():
    """frontera input con 0 kW → -0 normalizado a +0."""
    unit = _Unit("GEC32", "GECELCA 32", 270, "input", "single", ["h"])

    def factory(*, host, **_kw):
        return _FakeClient(0.0)

    poller = MeterPoller([unit], client_factory=factory)
    try:
        results = poller.poll()
    finally:
        poller.close()

    value = results[0]["value_kw"]
    assert value == 0.0
    assert math.copysign(1.0, value) == 1.0
