"""Topología y validación de variables de entorno.

Replica conceptual de `server/config.js`. Carga `.env` desde el directorio del
proyecto (`fabric-meter-sink/.env`) al importar.

Validación fail-fast: si falta cualquier IP/PSW/USER, levanta `ValueError` con la
lista completa de variables faltantes. Esto evita arranques en producción con
configuración incompleta.

Para herramientas que sólo necesitan la lista `UNITS` sin tener `.env` real
(tests, scripts ad-hoc), exportar `CONFIG_SKIP_VALIDATION=1`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_PROJECT_ROOT / ".env")


FrontierType = Literal["output", "input"]
CombineType = Literal["single", "sum"]


@dataclass(frozen=True)
class Meter:
    host: str
    user: str
    password: str
    ip_env: str
    psw_env: str


@dataclass(frozen=True)
class Unit:
    id: str
    label: str
    max_mw: int
    frontier_type: FrontierType
    combine: CombineType
    meters: tuple[Meter, ...]


METER_DEFAULTS = {
    "op_path": os.environ.get("METER_OP_PATH", "/Operation.html"),
    "timeout_s": float(os.environ.get("METER_TIMEOUT_S", "4")),
}


def _strip_quotes(value: str) -> str:
    return value.strip().strip('"').strip("'")


# ─── Loop / scheduling ────────────────────────────────────────────────────────
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "15"))
BUFFER_SIZE = int(os.environ.get("BUFFER_SIZE", "3"))

# ─── VACUUM / refresh ─────────────────────────────────────────────────────────
VACUUM_INTERVAL_S = int(os.environ.get("VACUUM_INTERVAL_S", "10800"))   # 3 h
VACUUM_RETAIN_HOURS = int(os.environ.get("VACUUM_RETAIN_HOURS", "0"))
REFRESH_INTERVAL_S = int(os.environ.get("REFRESH_INTERVAL_S", "60"))

# ─── Fabric (required at runtime, no default) ─────────────────────────────────
TENANT_ID = _strip_quotes(os.environ.get("TENANT_ID", ""))
CLIENT_ID = _strip_quotes(os.environ.get("CLIENT_ID", ""))
CLIENT_SECRET = _strip_quotes(os.environ.get("CLIENT_SECRET", ""))
FABRIC_WORKSPACE_ID = _strip_quotes(os.environ.get("FABRIC_WORKSPACE_ID", ""))
FABRIC_LAKEHOUSE_NAME = _strip_quotes(os.environ.get("FABRIC_LAKEHOUSE_NAME", ""))
FABRIC_LAKEHOUSE_SCHEMA = _strip_quotes(os.environ.get("FABRIC_LAKEHOUSE_SCHEMA", "")) or None
FABRIC_TABLE_NAME = _strip_quotes(os.environ.get("FABRIC_TABLE_NAME", ""))
FABRIC_SQL_ENDPOINT_ID = _strip_quotes(os.environ.get("FABRIC_SQL_ENDPOINT_ID", "")) or None

# ─── Heartbeat / logs ─────────────────────────────────────────────────────────
# En Linux apuntamos al tmpfs estándar de systemd; en Windows / dev usamos un
# path local relativo al proyecto para evitar permisos elevados.
_DEFAULT_HEARTBEAT = (
    "/var/run/fabric-meter-sink/heartbeat"
    if os.name == "posix"
    else str(_PROJECT_ROOT / "var" / "heartbeat")
)
HEARTBEAT_PATH = os.environ.get("HEARTBEAT_PATH", _DEFAULT_HEARTBEAT)
LOG_DIR = os.environ.get("LOG_DIR", str(_PROJECT_ROOT / "logs"))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

# ─── Failure escalation ───────────────────────────────────────────────────────
MAX_CONSECUTIVE_WRITE_FAILURES = int(os.environ.get("MAX_CONSECUTIVE_WRITE_FAILURES", "5"))
SHUTDOWN_TIMEOUT_S = int(os.environ.get("SHUTDOWN_TIMEOUT_S", "30"))


_TOPOLOGY: list[dict] = [
    {
        "id": "TGJ1", "label": "GUAJIRA 1", "max_mw": 145,
        "frontier_type": "output",
        "meter_envs": [("IP_TGJ1", "PSW_TGJ1")],
    },
    {
        "id": "TGJ2", "label": "GUAJIRA 2", "max_mw": 130,
        "frontier_type": "output",
        "meter_envs": [("IP_TGJ2", "PSW_TGJ2")],
    },
    {
        "id": "GEC3", "label": "GECELCA 3", "max_mw": 164,
        "frontier_type": "input",
        "meter_envs": [("IP_GEC3_1", "PSW_GEC3_1"), ("IP_GEC3_2", "PSW_GEC3_2")],
    },
    {
        "id": "GEC32", "label": "GECELCA 32", "max_mw": 270,
        "frontier_type": "input",
        "meter_envs": [("IP_GEC32", "PSW_GEC32")],
    },
]


def _build_units() -> list[Unit]:
    user = os.environ.get("USER_MEDIDORES", "")
    units: list[Unit] = []
    for spec in _TOPOLOGY:
        if spec["frontier_type"] not in ("output", "input"):
            raise ValueError(
                f"config: unit {spec['id']} frontier_type inválido "
                f"'{spec['frontier_type']}'"
            )
        meters = tuple(
            Meter(
                host=os.environ.get(ip_env, ""),
                user=user,
                password=os.environ.get(psw_env, ""),
                ip_env=ip_env,
                psw_env=psw_env,
            )
            for ip_env, psw_env in spec["meter_envs"]
        )
        units.append(
            Unit(
                id=spec["id"],
                label=spec["label"],
                max_mw=spec["max_mw"],
                frontier_type=spec["frontier_type"],
                combine="sum" if len(meters) > 1 else "single",
                meters=meters,
            )
        )
    return units


def _validate(units: list[Unit]) -> None:
    missing: list[str] = []
    for u in units:
        for m in u.meters:
            if not m.host:
                missing.append(f"{m.ip_env}  (unit={u.id})")
            if not m.user:
                missing.append("USER_MEDIDORES  (compartido)")
            if not m.password:
                missing.append(f"{m.psw_env}  (unit={u.id})")
    if missing:
        unique = list(dict.fromkeys(missing))
        raise ValueError(
            "Faltan variables de entorno (medidores ION8650):\n  - "
            + "\n  - ".join(unique)
            + "\n\nDefinirlas en fabric-meter-sink/.env. "
              "Para saltar la validación: CONFIG_SKIP_VALIDATION=1"
        )


UNITS: list[Unit] = _build_units()

if os.environ.get("CONFIG_SKIP_VALIDATION") != "1":
    _validate(UNITS)
