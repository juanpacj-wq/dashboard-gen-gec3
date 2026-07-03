from __future__ import annotations

import pytest

from src.meter_client import ION8650Client
from src.meter_client_factory import make_client_factory
from src.meter_modbus_client import ION8650ModbusClient

MODBUS_CFG = {
    "port": 502,
    "unit_id": 1,
    "register": 40204,
    "word_order": "high",
    "decode": "int32",
    "scale": 1000.0,
}


# ──────────────────────────────────────────────────────────────────────────────
# Selección de cliente por protocolo
# ──────────────────────────────────────────────────────────────────────────────


def test_modbus_factory_returns_modbus_client():
    factory = make_client_factory("modbus", MODBUS_CFG)
    client = factory(
        host="10.0.0.9", user="u", password="p", op_path="/Operation.html", timeout_s=4.0
    )
    try:
        assert isinstance(client, ION8650ModbusClient)
        assert client.host == "10.0.0.9"
    finally:
        client.close()


def test_http_factory_returns_http_client():
    factory = make_client_factory("http", MODBUS_CFG)
    client = factory(
        host="10.0.0.9", user="u", password="p", op_path="/Operation.html", timeout_s=4.0
    )
    try:
        assert isinstance(client, ION8650Client)
        assert client.url == "http://10.0.0.9/Operation.html"
    finally:
        client.close()


def test_protocol_is_case_insensitive():
    factory = make_client_factory("MODBUS", MODBUS_CFG)
    client = factory(
        host="10.0.0.9", user="u", password="p", op_path="/Operation.html", timeout_s=4.0
    )
    try:
        assert isinstance(client, ION8650ModbusClient)
    finally:
        client.close()


def test_invalid_protocol_raises():
    with pytest.raises(ValueError):
        make_client_factory("serial", MODBUS_CFG)


# ──────────────────────────────────────────────────────────────────────────────
# La factory Modbus no revienta por user/password vacíos y respeta el combo
# ──────────────────────────────────────────────────────────────────────────────


def test_modbus_factory_ignores_missing_http_credentials():
    factory = make_client_factory("modbus", MODBUS_CFG)
    # user="" y password="" (sin credenciales HTTP): Modbus no las necesita.
    client = factory(
        host="10.0.0.9", user="", password="", op_path="", timeout_s=4.0
    )
    try:
        assert isinstance(client, ION8650ModbusClient)
    finally:
        client.close()


def test_modbus_factory_passes_combo_to_client():
    cfg = {**MODBUS_CFG, "register": 40033, "scale": 10.0, "word_order": "low"}
    factory = make_client_factory("modbus", cfg)
    client = factory(
        host="10.0.0.9", user="u", password="p", op_path="/x", timeout_s=7.0
    )
    try:
        assert client._register == 40033
        assert client._offset == 40033 - 40001
        assert client._scale == 10.0
        assert client._word_order == "low"
        assert client._timeout_s == 7.0
    finally:
        client.close()


# ──────────────────────────────────────────────────────────────────────────────
# _validate() protocol-aware (config)
# ──────────────────────────────────────────────────────────────────────────────


def test_validate_modbus_does_not_require_http_credentials():
    from src import config
    from src.config import Meter, Unit

    # Unidad con host (IP) presente pero SIN credenciales HTTP (user/password vacíos).
    meter = Meter(host="10.0.0.1", user="", password="", ip_env="IP_X", psw_env="PSW_X")
    unit = Unit(
        id="TGJ1", label="X", max_mw=1, frontier_type="output", combine="single",
        meters=(meter,),
    )
    # modbus: no exige USER/PSW → no levanta.
    config._validate([unit], protocol="modbus")
    # http: exige USER/PSW → levanta.
    with pytest.raises(ValueError):
        config._validate([unit], protocol="http")
