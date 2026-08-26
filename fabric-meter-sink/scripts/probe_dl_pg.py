"""Valida end-to-end la escritura al sink espejo Postgres (dl_captura).

Escribe 1 fila dummy (sin tocar medidores reales) en
`generacion.brc_pgn_generacion_medidores`, la lee de vuelta y la imprime.
Crea el schema y la tabla si no existen (mismo DDL idempotente del servicio).

Uso: python -m scripts.probe_dl_pg
"""

from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Consola Windows default (cp1252) no puede imprimir ✓/✗ — forzar UTF-8.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from dotenv import load_dotenv  # noqa: E402

from src.fabric_writer import build_row, now_bogota_utc5  # noqa: E402
from src.pg_writer import COLUMNS, PostgresWriter  # noqa: E402

load_dotenv(_ROOT / ".env")


def _strip(value: str | None) -> str:
    if value is None:
        return ""
    return value.strip().strip('"').strip("'")


def _require(name: str) -> str:
    value = _strip(os.environ.get(name))
    if not value:
        print(f"ERROR: variable de entorno {name} vacía o faltante en .env")
        sys.exit(2)
    return value


def main() -> int:
    writer = PostgresWriter(
        host=_require("HOSTDL"),
        port=int(_strip(os.environ.get("PORT")) or "5432"),
        dbname=_require("DB"),
        user=_require("USERDL"),
        password=os.environ.get("PSWDL", ""),
        schema=_strip(os.environ.get("DL_PG_SCHEMA")) or "generacion",
        table=_strip(os.environ.get("DL_PG_TABLE")) or "brc_pgn_generacion_medidores",
    )
    print(f"Host:    {writer.host}:{writer.port}")
    print(f"DB:      {writer.dbname}")
    print(f"User:    {writer.user}")
    print(f"Destino: {writer.qualified_table}")
    print()

    now = now_bogota_utc5()
    dummy_units = [
        {"id": "TGJ1",  "value_kw": 100.0},
        {"id": "TGJ2",  "value_kw": 200.0},
        {"id": "GEC3",  "value_kw": -50.0},
        {"id": "GEC32", "value_kw": -300.0},
    ]
    row = build_row(dummy_units, now)
    print("Row a escribir:")
    for k, v in row.items():
        print(f"  {k:10s} = {v!r}")
    print()

    try:
        writer.write_overwrite([row])
        print("✓ Write OK (schema+tabla creados si no existían)")
    except Exception as exc:
        print(f"✗ Write falló: {type(exc).__name__}: {exc}")
        print()
        _classify_and_print(exc)
        traceback.print_exc()
        return 1

    try:
        conn = writer._get_conn()
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM {writer.qualified_table} ORDER BY ts_concat")
            rows = cur.fetchall()
        conn.commit()
        print()
        print(f"Read back desde Postgres ({len(rows)} fila/s):")
        print("  ".join(COLUMNS))
        for r in rows:
            print("  ".join(str(v) for v in r))
    except Exception as exc:
        print(f"✗ Read back falló: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return 1
    finally:
        writer.close()

    print()
    print("✓ End-to-end OK — Postgres dl_captura funciona desde esta máquina.")
    return 0


def _classify_and_print(exc: Exception) -> None:
    """Hints para los fallos más comunes (auth / firewall / ssl)."""
    msg = f"{type(exc).__name__}: {exc}".lower()
    if "password authentication failed" in msg or "role" in msg:
        print("  → Hint: AUTH. Revisar USERDL / PSWDL en .env.")
    elif any(t in msg for t in ("no pg_hba", "firewall", "not allowed to connect")):
        print(
            "  → Hint: FIREWALL. Agregar la IP pública de esta máquina a las "
            "reglas de firewall del servidor Azure PostgreSQL."
        )
    elif any(t in msg for t in ("timeout", "timed out", "unreachable", "refused")):
        print(
            "  → Hint: RED. Abrir saliente TCP 5432 hacia "
            "*.postgres.database.azure.com (o revisar firewall del server Azure)."
        )
    elif "ssl" in msg:
        print("  → Hint: SSL. Azure PG exige TLS; el writer ya usa sslmode=require.")
    elif "permission denied" in msg:
        print(
            "  → Hint: PERMISO. El usuario necesita CREATE en la BD (para el "
            "schema) o USAGE/INSERT sobre generacion.*."
        )


if __name__ == "__main__":
    sys.exit(main())
