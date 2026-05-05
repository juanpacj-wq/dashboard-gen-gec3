"""Probe puntual de los 5 medidores.

Equivalente Python de `server/scripts/probe-meters.js`. Recorre `UNITS`, golpea
cada medidor con un timeout corto, e imprime una tabla con `kW` y latencia por
medidor más una línea final con el valor combinado por unidad (después de sumar
y aplicar el signo).

Uso:
    cd fabric-meter-sink
    python scripts/probe_meters.py

Sale con código `0` si todos los medidores responden, `1` si alguno falla.
"""

from __future__ import annotations

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from src.config import METER_DEFAULTS, UNITS  # noqa: E402
from src.meter_client import ION8650Client  # noqa: E402
from src.sign_convention import aplicar_signo  # noqa: E402

PROBE_TIMEOUT_S = float(os.environ.get("PROBE_TIMEOUT_S", "5"))


def probe_meter(unit, meter, idx: int) -> dict:
    started = time.monotonic()
    client = ION8650Client(
        host=meter.host,
        user=meter.user,
        password=meter.password,
        op_path=METER_DEFAULTS["op_path"],
        timeout_s=PROBE_TIMEOUT_S,
    )
    try:
        result = client.fetch_kw_total()
        return {
            "unit": unit.id,
            "idx": idx,
            "host": meter.host,
            "ok": True,
            "kw": result["kw"],
            "latency_ms": result["latency_ms"],
        }
    except Exception as exc:
        return {
            "unit": unit.id,
            "idx": idx,
            "host": meter.host,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "latency_ms": int((time.monotonic() - started) * 1000),
        }
    finally:
        client.close()


def _pad(s: object, n: int) -> str:
    text = str(s)
    if len(text) >= n:
        return text + " "
    return text + " " * (n - len(text))


def main() -> int:
    print(
        f"Probing {len(UNITS)} units "
        f"(op_path={METER_DEFAULTS['op_path']}, timeout={PROBE_TIMEOUT_S}s)\n"
    )

    tasks = []
    for unit in UNITS:
        for i, meter in enumerate(unit.meters):
            tasks.append((unit, meter, i))

    with ThreadPoolExecutor(max_workers=max(1, len(tasks))) as executor:
        futures = [executor.submit(probe_meter, u, m, i) for u, m, i in tasks]
        results = [f.result() for f in futures]

    header = (
        _pad("UNIT", 7) + _pad("M", 3) + _pad("HOST", 24)
        + _pad("STATUS", 8) + _pad("kW", 14) + "LAT/INFO"
    )
    print(header)
    print("─" * (len(header) + 20))
    for r in results:
        status = "OK" if r["ok"] else "FAIL"
        kw_str = f"{r['kw']:.2f}" if r["ok"] else "—"
        info = f"{r['latency_ms']}ms" if r["ok"] else r["error"]
        print(
            _pad(r["unit"], 7) + _pad(f"m{r['idx']}", 3)
            + _pad(r["host"], 24) + _pad(status, 8)
            + _pad(kw_str, 14) + info
        )

    print()
    combined_parts: list[str] = []
    by_unit: dict[str, list[dict]] = {}
    for r in results:
        by_unit.setdefault(r["unit"], []).append(r)
    for unit in UNITS:
        unit_results = by_unit.get(unit.id, [])
        if not unit_results or not all(r["ok"] for r in unit_results):
            combined_parts.append(f"{unit.id}=ERR")
            continue
        kws = [r["kw"] for r in sorted(unit_results, key=lambda r: r["idx"])]
        total = sum(kws) if unit.combine == "sum" else kws[0]
        value_kw = aplicar_signo(unit.frontier_type, total)
        combined_parts.append(f"{unit.id}={value_kw:.2f} kW")
    print("  ".join(combined_parts))

    all_ok = all(r["ok"] for r in results)
    print()
    print(
        "✓ Todos los medidores responden."
        if all_ok
        else "✗ Hay medidores con fallo — revisar credenciales/red/path antes de iniciar el server."
    )
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
