"""Cliente Modbus TCP para medidores Schneider PowerLogic ION8650.

Port directo de `server/meterModbusClient.js` (Node, combo validado en D-118/D-120).
Lee el `kW total` por Function 03 (Read Holding Registers) del registro 40204 y lo
decodifica como INT32 con escala /1000. La firma pública es IDÉNTICA al cliente HTTP
`ION8650Client` (`fetch_kw_total()` / `close()` / `host`), de modo que es un drop-in
detrás del `client_factory` del `MeterPoller`: el poller consume `result["kw"]` sin
saber el protocolo, y aplica combine/signo aguas arriba (ver `sign_convention.py`).

El medidor reporta el `kW total` desde la perspectiva del punto físico donde está
instalado — acá NO se aplica la convención de signos. El cero y los negativos son
datos válidos.

Notas de pymodbus 3.7.x (verificado en E1, ver ESTADO.md → Datos descubiertos):
- `read_holding_registers(address, count=2, slave=unit_id)` — el kwarg del esclavo es
  `slave=` en esta versión.
- Un fallo de conexión LANZA `ConnectionException`. En cambio, un timeout de lectura
  RETORNA un `ModbusIOException` (objeto con `.isError() is True`), no lo lanza.
- Una excepción de protocolo (frame 0x83…) RETORNA un `ExceptionResponse` con
  `.exception_code` y `.isError() is True`.
- Una lectura correcta retorna un response con `.registers` (lista de uint16) y
  `.isError() is False`.
"""

from __future__ import annotations

import logging
import math
import struct
import time
from datetime import datetime, timezone

from pymodbus.client import ModbusTcpClient
from pymodbus.exceptions import ModbusIOException

from .meter_client import (
    MeterError,
    MeterFormatError,
    MeterReading,
    MeterTimeoutError,
)

logger = logging.getLogger(__name__)

DEFAULT_PORT = 502
DEFAULT_UNIT_ID = 1
DEFAULT_REGISTER = 40204        # kW tot scaled (INT32, escala /1000) — match del HTML
DEFAULT_WORD_ORDER = "high"     # 'high' = palabra alta primero (ABCD, doc Schneider) | 'low'
DEFAULT_DECODE = "int32"        # 'int32' (con signo) | 'float32'
DEFAULT_SCALE = 1000.0          # /10 para 40033, /1000 para 40204, 1 para float32
DEFAULT_TIMEOUT_S = 4.0
MODBUS_BASE = 40001             # registro doc 4xxxx → offset 0-based = reg - 40001

# Pistas de timeout / sin-respuesta en el texto del error (además del tipo).
_TIMEOUT_HINTS = ("timeout", "timed out", "no response", "sin respuesta")


class MeterModbusException(MeterError):
    """Excepción de protocolo Modbus (frame 0x83 + código).

    NO es transitoria: el código 0x02 (Illegal Data Address) suele significar que el
    Modbus Map Access está bloqueado por Advanced Security en el medidor — el operador
    debe verlo. Es el análogo semántico de `MeterAuthError` del lado HTTP.
    """

    def __init__(
        self, message: str, *, host: str | None = None, exception_code: int | None = None
    ) -> None:
        super().__init__(message, host=host)
        self.exception_code = exception_code


def _strip_scheme(host: str) -> str:
    """Quita un `http(s)://` accidental y cualquier path; el puerto va aparte."""
    text = str(host).strip()
    for scheme in ("http://", "https://"):
        if text.lower().startswith(scheme):
            text = text[len(scheme):]
            break
    return text.split("/", 1)[0]


def decode_registers(regs: list[int], word_order: str, decode: str) -> float:
    """Decodifica dos registros de 16 bits a un número (equivale al `readInt32BE` del Node).

    `regs` es `[reg0, reg1]`, cada uno uint16 big-endian intra-registro. `word_order`
    solo intercambia las dos palabras de 16 bits:
      - 'high' (ABCD): `reg0` es la palabra alta → orden tal cual.
      - 'low'  (CDAB): `reg0` es la palabra baja → swap `[reg1, reg0]`.
    """
    if word_order == "low":
        packed = struct.pack(">HH", regs[1], regs[0])
    else:
        packed = struct.pack(">HH", regs[0], regs[1])
    if decode == "float32":
        return struct.unpack(">f", packed)[0]
    return float(struct.unpack(">i", packed)[0])


class ION8650ModbusClient:
    """Cliente Modbus TCP para un medidor ION8650."""

    def __init__(
        self,
        *,
        host: str,
        port: int = DEFAULT_PORT,
        unit_id: int = DEFAULT_UNIT_ID,
        register: int = DEFAULT_REGISTER,
        word_order: str = DEFAULT_WORD_ORDER,
        decode: str = DEFAULT_DECODE,
        scale: float = DEFAULT_SCALE,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        client: object | None = None,
    ) -> None:
        if not host:
            raise TypeError("ION8650ModbusClient: host required")
        if not isinstance(register, int) or register < MODBUS_BASE:
            raise TypeError(
                f"ION8650ModbusClient: register inválido '{register}' (esperado 4xxxx)"
            )
        if word_order not in ("high", "low"):
            raise TypeError(
                f"ION8650ModbusClient: word_order inválido '{word_order}' (high|low)"
            )
        if decode not in ("int32", "float32"):
            raise TypeError(
                f"ION8650ModbusClient: decode inválido '{decode}' (int32|float32)"
            )

        self._host = _strip_scheme(host)
        self._port = port
        self._unit_id = unit_id
        self._register = register
        self._offset = register - MODBUS_BASE
        self._word_order = word_order
        self._decode = decode
        self._scale = scale
        self._timeout_s = timeout_s
        # Cliente inyectable para tests; en producción, un ModbusTcpClient real. La
        # conexión es perezosa: no se abre el socket hasta el primer fetch.
        self._client = client if client is not None else ModbusTcpClient(
            self._host, port=self._port, timeout=self._timeout_s
        )

    @property
    def host(self) -> str:
        return self._host

    def fetch_kw_total(self) -> MeterReading:
        started = time.monotonic()
        self._ensure_connected()

        try:
            result = self._client.read_holding_registers(
                self._offset, count=2, slave=self._unit_id
            )
        except Exception as exc:
            self._mark_disconnected()
            raise self._map_error(exc) from exc

        if result.isError():
            self._mark_disconnected()
            raise self._map_error_response(result)

        regs = getattr(result, "registers", None)
        if not regs or len(regs) < 2:
            raise MeterFormatError(
                f"Respuesta Modbus sin 2 registros "
                f"(host={self._host} reg={self._register} len={len(regs) if regs else 0})",
                host=self._host,
            )

        raw = decode_registers(regs, self._word_order, self._decode)
        kw = raw / self._scale
        if not math.isfinite(kw):
            raise MeterFormatError(
                f"Valor Modbus no finito (host={self._host} reg={self._register} raw={raw})",
                host=self._host,
            )
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "kw": float(kw),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "latency_ms": latency_ms,
        }

    def _ensure_connected(self) -> None:
        """Conexión persistente perezosa: reconecta solo si el socket no está abierto."""
        try:
            if self._client.is_socket_open():
                return
            if not self._client.connect():
                raise MeterError(
                    f"No se pudo conectar a Modbus {self._host}:{self._port}",
                    host=self._host,
                )
        except MeterError:
            self._mark_disconnected()
            raise
        except Exception as exc:
            self._mark_disconnected()
            raise self._map_error(exc) from exc

    def _mark_disconnected(self) -> None:
        """Cierra el socket y fuerza reconexión en el próximo fetch (espeja el Node)."""
        try:
            self._client.close()
        except Exception:
            pass

    def _map_error_response(self, result: object) -> MeterError:
        """Mapea un response con `.isError()` (protocolo o IO sin-respuesta)."""
        code = getattr(result, "exception_code", None)
        if code is not None:
            return MeterModbusException(
                f"Modbus exception {code} at {self._host}:{self._port} "
                f"(unit={self._unit_id} reg={self._register})",
                host=self._host,
                exception_code=code,
            )
        # ModbusIOException retornado (sin respuesta / no decodificable): timeout a nivel app.
        return MeterTimeoutError(
            f"Sin respuesta Modbus {self._host}:{self._port} "
            f"(unit={self._unit_id} reg={self._register})",
            host=self._host,
        )

    def _map_error(self, exc: Exception) -> MeterError:
        """Mapea excepciones lanzadas, análogo a `#mapError` del Node."""
        if isinstance(exc, MeterError):
            return exc
        code = getattr(exc, "exception_code", None)
        if code is not None:
            return MeterModbusException(
                f"Modbus exception {code} at {self._host}:{self._port} "
                f"(unit={self._unit_id} reg={self._register})",
                host=self._host,
                exception_code=code,
            )
        msg = str(exc).lower()
        if isinstance(exc, ModbusIOException) or any(h in msg for h in _TIMEOUT_HINTS):
            return MeterTimeoutError(
                f"Timeout ({self._timeout_s}s) Modbus {self._host}:{self._port}",
                host=self._host,
            )
        # ConnectionException, errores de socket/red, o ModbusException genérica.
        return MeterError(
            f"Error Modbus {self._host}:{self._port}: {exc}",
            host=self._host,
        )

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    def __enter__(self) -> ION8650ModbusClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
