from __future__ import annotations

import struct

import pytest
from pymodbus.exceptions import ConnectionException, ModbusIOException

from src.meter_client import MeterError, MeterFormatError, MeterTimeoutError
from src.meter_modbus_client import (
    ION8650ModbusClient,
    MeterModbusException,
    decode_registers,
)

# ──────────────────────────────────────────────────────────────────────────────
# Helpers: codificar un valor a los dos registros uint16 que devolvería el medidor
# ──────────────────────────────────────────────────────────────────────────────


def regs_int32(value: int, word_order: str = "high") -> list[int]:
    hi, lo = struct.unpack(">HH", struct.pack(">i", value))
    return [lo, hi] if word_order == "low" else [hi, lo]


def regs_float32(value: float, word_order: str = "high") -> list[int]:
    hi, lo = struct.unpack(">HH", struct.pack(">f", value))
    return [lo, hi] if word_order == "low" else [hi, lo]


class FakeResp:
    """Espeja un response de pymodbus: `.registers`, `.exception_code`, `.isError()`."""

    def __init__(self, registers=None, exception_code=None, error=False):
        self.registers = registers
        if exception_code is not None:
            self.exception_code = exception_code
        self._error = error or exception_code is not None

    def isError(self) -> bool:
        return self._error


class FakeModbus:
    """Fake pymodbus-like inyectable vía `client=`."""

    def __init__(
        self, *, response=None, raises=None, connect_result=True, open_after_connect=True
    ):
        self.response = response
        self.raises = raises
        self.connect_result = connect_result
        self.open_after_connect = open_after_connect
        self._open = False
        self.calls: list[dict] = []
        self.closed = 0

    def is_socket_open(self) -> bool:
        return self._open

    def connect(self) -> bool:
        if self.connect_result:
            self._open = self.open_after_connect
        return self.connect_result

    def read_holding_registers(self, address, count=1, slave=1):
        self.calls.append({"address": address, "count": count, "slave": slave})
        if self.raises is not None:
            raise self.raises
        return self.response

    def close(self) -> None:
        self.closed += 1
        self._open = False


def make_client(fake: FakeModbus, **kwargs) -> ION8650ModbusClient:
    params = {"host": "10.0.0.1", "client": fake}
    params.update(kwargs)
    return ION8650ModbusClient(**params)


# ──────────────────────────────────────────────────────────────────────────────
# Constructor / validación
# ──────────────────────────────────────────────────────────────────────────────


def test_constructor_rejects_missing_host():
    with pytest.raises(TypeError):
        ION8650ModbusClient(host="", client=FakeModbus())


def test_constructor_rejects_invalid_register():
    with pytest.raises(TypeError):
        make_client(FakeModbus(), register=204)  # < 40001


def test_constructor_rejects_invalid_word_order():
    with pytest.raises(TypeError):
        make_client(FakeModbus(), word_order="mid")


def test_constructor_rejects_invalid_decode():
    with pytest.raises(TypeError):
        make_client(FakeModbus(), decode="int16")


def test_offset_is_register_minus_base():
    fake = FakeModbus(response=FakeResp(registers=regs_int32(145000)))
    client = make_client(fake, register=40204)
    client.fetch_kw_total()
    assert fake.calls[0]["address"] == 203  # 40204 - 40001
    assert fake.calls[0]["count"] == 2
    assert fake.calls[0]["slave"] == 1


def test_strips_scheme_and_path_from_host():
    client = make_client(FakeModbus(), host="http://192.168.1.5/x")
    assert client.host == "192.168.1.5"


# ──────────────────────────────────────────────────────────────────────────────
# Decode / lectura correcta
# ──────────────────────────────────────────────────────────────────────────────


def test_int32_high_positive():
    fake = FakeModbus(response=FakeResp(registers=regs_int32(145000)))
    result = make_client(fake).fetch_kw_total()
    assert result["kw"] == 145.0
    assert isinstance(result["fetched_at"], str)
    assert isinstance(result["latency_ms"], int)


def test_int32_negative_gecelca_no_sign_inversion():
    # Gecelca es 'input' (invierte signo), pero eso lo hace el poller aguas arriba.
    # El cliente devuelve el crudo con signo tal cual lo reporta el medidor.
    fake = FakeModbus(response=FakeResp(registers=regs_int32(-164000)))
    result = make_client(fake).fetch_kw_total()
    assert result["kw"] == -164.0
    assert result["kw"] < 0


def test_word_order_low_swaps_words():
    fake = FakeModbus(response=FakeResp(registers=regs_int32(145000, word_order="low")))
    result = make_client(fake, word_order="low").fetch_kw_total()
    assert result["kw"] == 145.0


def test_decode_float32_scale_1():
    fake = FakeModbus(response=FakeResp(registers=regs_float32(145.5)))
    result = make_client(fake, decode="float32", scale=1.0).fetch_kw_total()
    assert result["kw"] == pytest.approx(145.5)


def test_scale_10_for_register_40033():
    # raw 1450 con scale 10 → 145.0 (combo alterno mencionado en el contexto).
    fake = FakeModbus(response=FakeResp(registers=regs_int32(1450)))
    result = make_client(fake, register=40033, scale=10.0).fetch_kw_total()
    assert result["kw"] == 145.0


def test_decode_registers_helper_matches():
    assert decode_registers(regs_int32(145000), "high", "int32") == 145000.0
    assert decode_registers(regs_int32(145000, "low"), "low", "int32") == 145000.0


# ──────────────────────────────────────────────────────────────────────────────
# Mapeo de errores
# ──────────────────────────────────────────────────────────────────────────────


def test_returned_io_error_maps_to_timeout():
    # pymodbus 3.7 RETORNA un error-response (isError, sin exception_code) en timeout.
    fake = FakeModbus(response=FakeResp(error=True))
    with pytest.raises(MeterTimeoutError):
        make_client(fake).fetch_kw_total()


def test_raised_modbus_io_exception_maps_to_timeout():
    fake = FakeModbus(raises=ModbusIOException("No Response received"))
    with pytest.raises(MeterTimeoutError):
        make_client(fake).fetch_kw_total()


def test_protocol_exception_maps_to_modbus_exception_with_code():
    fake = FakeModbus(response=FakeResp(exception_code=2))
    with pytest.raises(MeterModbusException) as exc_info:
        make_client(fake).fetch_kw_total()
    assert exc_info.value.exception_code == 2
    assert exc_info.value.host == "10.0.0.1"


def test_connection_failure_maps_to_meter_error():
    fake = FakeModbus(connect_result=False)
    with pytest.raises(MeterError) as exc_info:
        make_client(fake).fetch_kw_total()
    # No es timeout: es fallo de conexión.
    assert not isinstance(exc_info.value, MeterTimeoutError)


def test_raised_connection_exception_maps_to_meter_error():
    fake = FakeModbus(raises=ConnectionException("refused"))
    with pytest.raises(MeterError) as exc_info:
        make_client(fake).fetch_kw_total()
    assert not isinstance(exc_info.value, (MeterTimeoutError, MeterModbusException))


def test_short_response_maps_to_format_error():
    fake = FakeModbus(response=FakeResp(registers=[42]))  # solo 1 registro
    with pytest.raises(MeterFormatError):
        make_client(fake).fetch_kw_total()


def test_non_finite_value_maps_to_format_error():
    fake = FakeModbus(response=FakeResp(registers=regs_float32(float("nan"))))
    with pytest.raises(MeterFormatError):
        make_client(fake, decode="float32", scale=1.0).fetch_kw_total()


# ──────────────────────────────────────────────────────────────────────────────
# Reconexión / close
# ──────────────────────────────────────────────────────────────────────────────


def test_error_marks_disconnected():
    fake = FakeModbus(raises=ModbusIOException("boom"))
    client = make_client(fake)
    with pytest.raises(MeterTimeoutError):
        client.fetch_kw_total()
    assert fake.closed >= 1  # _mark_disconnected cerró el socket


def test_close_swallows_and_closes():
    fake = FakeModbus(response=FakeResp(registers=regs_int32(1000)))
    client = make_client(fake)
    client.fetch_kw_total()
    client.close()
    assert fake.closed >= 1
