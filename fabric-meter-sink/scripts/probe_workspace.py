"""Lista los Lakehouses del workspace de Fabric.

Útil ANTES de configurar `FABRIC_LAKEHOUSE_NAME`: el `displayName` que se ve en
la UI de Fabric puede tener mayúsculas/espacios distintos al ID o al path.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Usa el almacén de certificados de Windows (donde IT ya instaló la CA del
# proxy corporativo). Tiene que correr ANTES de cualquier import que use SSL.
import truststore  # noqa: E402

truststore.inject_into_ssl()

import requests  # noqa: E402
from azure.identity import ClientSecretCredential  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(_ROOT / ".env")

FABRIC_API_SCOPE = "https://api.fabric.microsoft.com/.default"


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip().strip('"').strip("'")
    if not value:
        print(f"ERROR: variable de entorno {name} vacía o faltante en .env")
        sys.exit(2)
    return value


def _pad(s: object, n: int) -> str:
    text = str(s)
    if len(text) >= n:
        return text + " "
    return text + " " * (n - len(text))


def main() -> int:
    tenant_id = _require("TENANT_ID")
    client_id = _require("CLIENT_ID")
    client_secret = _require("CLIENT_SECRET")
    workspace_id = _require("FABRIC_WORKSPACE_ID")

    cred = ClientSecretCredential(tenant_id, client_id, client_secret)
    try:
        token = cred.get_token(FABRIC_API_SCOPE)
    except Exception as exc:
        print(f"ERROR obteniendo token (auth): {type(exc).__name__}: {exc}")
        return 1

    url = f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}/items"
    response = requests.get(
        url,
        headers={"Authorization": f"Bearer {token.token}"},
        timeout=30,
    )
    if response.status_code != 200:
        print(f"HTTP {response.status_code} — {response.text[:500]}")
        return 1

    items = response.json().get("value", [])
    if not items:
        print(f"No hay items en el workspace {workspace_id}")
        return 1

    by_type: dict[str, list[dict]] = {}
    for item in items:
        by_type.setdefault(item.get("type", "?"), []).append(item)

    for type_name in sorted(by_type):
        group = by_type[type_name]
        print(f"\n── {type_name} ({len(group)}) ─────────────────────────────")
        header = _pad("DISPLAY NAME", 32) + _pad("ID", 38) + "DESCRIPTION"
        print(header)
        print("─" * (len(header) + 30))
        for item in group:
            name = item.get("displayName", "?")
            item_id = item.get("id", "?")
            desc = (item.get("description") or "").replace("\n", " ")[:60]
            print(_pad(name, 32) + _pad(item_id, 38) + desc)

    print()
    print("Hints para tu .env:")
    print("  FABRIC_LAKEHOUSE_NAME=<id de un Lakehouse de arriba>")
    print("  FABRIC_SQL_ENDPOINT_ID=<id de un SQLEndpoint / SQLAnalyticsEndpoint>")
    print("  (dejá FABRIC_SQL_ENDPOINT_ID vacío si querés saltar el refresh manual)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
