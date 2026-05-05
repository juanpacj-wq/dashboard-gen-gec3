"""Valida end-to-end la escritura a Fabric Delta.

Escribe 1 fila dummy (sin tocar medidores reales), la lee de vuelta y la
imprime. Si el path con schema falla con un error que sugiere "tabla no
encontrada" / "path inválido", reintenta sin schema y reporta para que ajustes
`FABRIC_LAKEHOUSE_SCHEMA=` (vacío) en `.env`.
"""

from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Usa el almacén de certificados de Windows (donde IT ya instaló la CA del
# proxy corporativo). Tiene que correr ANTES de cualquier import que use SSL.
import truststore  # noqa: E402

truststore.inject_into_ssl()

from deltalake import DeltaTable  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from src.fabric_writer import FabricWriter, build_row, now_bogota_utc5  # noqa: E402

load_dotenv(_ROOT / ".env")

_TABLE_NOT_FOUND_HINTS = (
    "table not found",
    "no such file",
    "no such directory",
    "path not found",
    "not found",
    "invalid path",
    "tablenotfound",
    "deltatablenotexist",
)


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


def _make_writer(schema: str | None) -> FabricWriter:
    return FabricWriter(
        tenant_id=_require("TENANT_ID"),
        client_id=_require("CLIENT_ID"),
        client_secret=_require("CLIENT_SECRET"),
        workspace_id=_require("FABRIC_WORKSPACE_ID"),
        lakehouse_name=_require("FABRIC_LAKEHOUSE_NAME"),
        table_name=_require("FABRIC_TABLE_NAME"),
        schema=schema,
    )


def _looks_like_path_error(exc: Exception) -> bool:
    msg = f"{type(exc).__name__}: {exc}".lower()
    return any(hint in msg for hint in _TABLE_NOT_FOUND_HINTS)


def main() -> int:
    requested_schema = _strip(os.environ.get("FABRIC_LAKEHOUSE_SCHEMA")) or None

    writer = _make_writer(requested_schema)
    print(f"Workspace:  {writer.workspace_id}")
    print(f"Lakehouse:  {writer.lakehouse_name}")
    print(f"Schema:     {writer.schema or '(none)'}")
    print(f"Table:      {writer.table_name}")
    print(f"Path:       {writer.get_table_path()}")
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

    active_writer = writer
    try:
        active_writer.write_overwrite([row])
        print("✓ Write OK")
    except Exception as exc:
        if requested_schema and _looks_like_path_error(exc):
            print(
                f"Write con schema={requested_schema!r} falló — parece que el "
                f"Lakehouse no tiene schemas habilitados:\n  {type(exc).__name__}: {exc}"
            )
            print("Reintentando sin schema...")
            try:
                active_writer = _make_writer(None)
                active_writer.write_overwrite([row])
                print("✓ Write OK SIN schema.")
                print(
                    f"→ Ajustá `FABRIC_LAKEHOUSE_SCHEMA=` (vacío) en tu .env "
                    f"— el Lakehouse '{writer.lakehouse_name}' no tiene schemas."
                )
            except Exception as inner:
                print("✗ Write SIN schema también falló:")
                print(f"  {type(inner).__name__}: {inner}")
                print()
                _classify_and_print(inner)
                traceback.print_exc()
                return 1
        else:
            print(f"✗ Write falló: {type(exc).__name__}: {exc}")
            print()
            _classify_and_print(exc)
            traceback.print_exc()
            return 1

    try:
        dt = DeltaTable(
            active_writer.get_table_path(),
            storage_options=active_writer.get_storage_options(),
        )
        arrow_table = dt.to_pyarrow_table()
        rows = arrow_table.to_pylist()
        print()
        print(f"Read back desde Fabric ({len(rows)} fila/s):")
        cols = arrow_table.column_names
        widths = {
            c: max(len(c), *(len(str(r.get(c))) for r in rows)) for c in cols
        } if rows else {c: len(c) for c in cols}
        print("  ".join(c.ljust(widths[c]) for c in cols))
        for r in rows:
            print("  ".join(str(r.get(c)).ljust(widths[c]) for c in cols))
    except Exception as exc:
        print(f"✗ Read back falló: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return 1

    print()
    print("✓ End-to-end OK — Fabric Lakehouse Delta funciona desde on-prem.")
    return 0


def _classify_and_print(exc: Exception) -> None:
    """Hint-based classifier for the most common failures (auth/path/schema)."""
    msg = f"{type(exc).__name__}: {exc}".lower()
    if any(t in msg for t in ("401", "unauthorized", "invalid client", "aadsts")):
        print("  → Hint: AUTH. Revisar TENANT_ID / CLIENT_ID / CLIENT_SECRET.")
    elif any(t in msg for t in ("403", "forbidden", "permission")):
        print(
            "  → Hint: PERMISO. El service principal debe ser Contributor del "
            "workspace y los settings de Fabric Admin pueden tardar 15-30 min "
            "en propagarse."
        )
    elif any(t in msg for t in ("dns", "timeout", "connection refused", "unreachable")):
        print(
            "  → Hint: RED. Abrir saliente desde el server on-prem a "
            "*.dfs.fabric.microsoft.com y login.microsoftonline.com."
        )
    elif "schema" in msg:
        print(
            "  → Hint: SCHEMA mismatch. Asegurate de que write_overwrite usa "
            "schema_mode='overwrite' (ya está por defecto)."
        )


if __name__ == "__main__":
    sys.exit(main())
