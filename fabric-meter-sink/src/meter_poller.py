"""Orquestador de medidores: combina las lecturas por unidad y aplica el signo.

Versión simplificada de `server/meterPoller.js` (sin watchdog/heartbeat — eso lo
maneja systemd más adelante). Hace una vuelta sincrónica a los 5 medidores en
paralelo con `ThreadPoolExecutor` y devuelve por unidad el `value_kw` ya
combinado y con la convención de signos aplicada.

Aislamiento: si **cualquier** medidor de una unidad falla en un ciclo, esa unidad
reporta `value_kw = None` (no parciales). Las demás unidades siguen normales.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

from .meter_client import ION8650Client
from .sign_convention import aplicar_signo

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 4.0
DEFAULT_OP_PATH = "/Operation.html"


class _ClientLike(Protocol):
    def fetch_kw_total(self) -> dict[str, Any]: ...
    def close(self) -> None: ...


ClientFactory = Callable[..., _ClientLike]


def _default_client_factory(
    *, host: str, user: str, password: str, op_path: str, timeout_s: float
) -> _ClientLike:
    return ION8650Client(
        host=host,
        user=user,
        password=password,
        op_path=op_path,
        timeout_s=timeout_s,
    )


class MeterPoller:
    def __init__(
        self,
        units: list,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        op_path: str = DEFAULT_OP_PATH,
        client_factory: ClientFactory | None = None,
    ) -> None:
        if not units:
            raise ValueError("MeterPoller: units must be a non-empty list")
        for u in units:
            if not getattr(u, "id", None):
                raise ValueError("MeterPoller: each unit needs an id")
            if not u.meters:
                raise ValueError(f"MeterPoller: unit {u.id} has no meters")
            if len(u.meters) > 1 and u.combine != "sum":
                raise ValueError(
                    f"MeterPoller: unit {u.id} has {len(u.meters)} meters but "
                    f"combine='{u.combine}'. Use 'sum'."
                )

        self._units = units
        self._timeout_s = timeout_s
        self._op_path = op_path
        self._client_factory = client_factory or _default_client_factory

        self._clients: dict[tuple[str, str], _ClientLike] = {}
        for unit in units:
            for meter in unit.meters:
                key = (unit.id, meter.host)
                if key in self._clients:
                    continue
                self._clients[key] = self._client_factory(
                    host=meter.host,
                    user=meter.user,
                    password=meter.password,
                    op_path=op_path,
                    timeout_s=timeout_s,
                )

    @property
    def units(self) -> list:
        return self._units

    def poll(self) -> list[dict[str, Any]]:
        """Una vuelta sincrónica a todos los medidores. Devuelve una lista por unidad."""
        max_workers = max(1, len(self._clients))
        kw_per_unit: dict[str, dict[str, float]] = {}
        errors_per_unit: dict[str, list[tuple[str, BaseException]]] = {}

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {}
            for unit in self._units:
                for meter in unit.meters:
                    client = self._clients[(unit.id, meter.host)]
                    future = executor.submit(client.fetch_kw_total)
                    future_map[future] = (unit.id, meter.host)

            for future, (unit_id, host) in future_map.items():
                try:
                    result = future.result()
                    kw_per_unit.setdefault(unit_id, {})[host] = float(result["kw"])
                except Exception as exc:
                    errors_per_unit.setdefault(unit_id, []).append((host, exc))
                    logger.warning(
                        "meter fetch failed (unit=%s host=%s): %s: %s",
                        unit_id, host, type(exc).__name__, exc,
                    )

        results: list[dict[str, Any]] = []
        for unit in self._units:
            if unit.id in errors_per_unit:
                value_kw: float | None = None
            else:
                kws = [kw_per_unit[unit.id][m.host] for m in unit.meters]
                total = sum(kws) if unit.combine == "sum" else kws[0]
                value_kw = aplicar_signo(unit.frontier_type, total)
            results.append(
                {
                    "id": unit.id,
                    "label": unit.label,
                    "value_kw": value_kw,
                    "max_mw": unit.max_mw,
                }
            )

        summary = {r["id"]: r["value_kw"] for r in results}
        logger.info("poll complete: %s", summary)
        return results

    def close(self) -> None:
        for client in self._clients.values():
            try:
                client.close()
            except Exception:
                pass

    def __enter__(self) -> MeterPoller:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
