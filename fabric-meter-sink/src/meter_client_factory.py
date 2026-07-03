"""Factory de clientes de medidor según el protocolo configurado.

Espeja `server/meterClientFactory.js`: devuelve una función con la MISMA firma que el
`MeterPoller` ya invoca —`(*, host, user, password, op_path, timeout_s)`— que instancia
el cliente correcto según `METER_PROTOCOL`. Así el poller es agnóstico del protocolo: solo
consume `result["kw"]` y aplica combine/signo aguas arriba.

- `modbus` → `ION8650ModbusClient` (ignora `user`/`password`/`op_path`).
- `http`   → `ION8650Client` (idéntico al `_default_client_factory` del poller).
"""

from __future__ import annotations

from typing import Any

from .meter_client import ION8650Client
from .meter_modbus_client import ION8650ModbusClient
from .meter_poller import ClientFactory, _ClientLike


def make_client_factory(protocol: str, modbus_cfg: dict[str, Any]) -> ClientFactory:
    """Devuelve un `client_factory` para inyectar en `MeterPoller`.

    `modbus_cfg` trae el combo compartido (`port`, `unit_id`, `register`, `word_order`,
    `decode`, `scale`); el `unit_id` es global = 1. Un override por medidor
    (`MB_UNIT_<ip_env>`) sería la extensión futura y entraría acá, resolviendo el unit id
    por host antes de construir el cliente; hoy no se implementa.
    """
    proto = protocol.lower()

    if proto == "modbus":
        def _modbus_factory(
            *, host: str, user: str, password: str, op_path: str, timeout_s: float
        ) -> _ClientLike:
            # user/password/op_path se ignoran: Modbus usa solo el host.
            return ION8650ModbusClient(host=host, timeout_s=timeout_s, **modbus_cfg)

        return _modbus_factory

    if proto == "http":
        def _http_factory(
            *, host: str, user: str, password: str, op_path: str, timeout_s: float
        ) -> _ClientLike:
            return ION8650Client(
                host=host,
                user=user,
                password=password,
                op_path=op_path,
                timeout_s=timeout_s,
            )

        return _http_factory

    raise ValueError(
        f"METER_PROTOCOL inválido '{protocol}' (esperado 'modbus' | 'http')"
    )
