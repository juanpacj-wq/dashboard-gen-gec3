"""Escritura a tabla Delta en Microsoft Fabric Lakehouse vía OneLake.

Sustituye la escritura del notebook actual de Fabric (ver `server/notebook.py`).
Cliente Delta: `deltalake` (delta-rs) — sin Spark, sin Java. Auth con Service
Principal vía `azure-identity.ClientSecretCredential`.

⚠️ COLUMNA HISTÓRICA `ge32` (sin C) ⚠️
La tabla Delta tiene una columna llamada **`ge32`** para Gecelca 32 (en lugar
del esperado `gec32`). Es **intencional, no un typo**: hay un report Power BI
en producción que ya consume esa columna por ese nombre. Renombrarla rompería
el report. El id interno de la unidad sí es `GEC32`; el mapping a `ge32` se
hace al construir la fila Fabric.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pyarrow as pa
import requests
from azure.identity import ClientSecretCredential
from deltalake import DeltaTable, write_deltalake

_GUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

logger = logging.getLogger(__name__)

STORAGE_SCOPE = "https://storage.azure.com/.default"
FABRIC_API_SCOPE = "https://api.fabric.microsoft.com/.default"

_TOKEN_REFRESH_MARGIN_S = 60

# ⚠️ Mapping de id de unidad → columna de la tabla Delta.
# `GEC32 → 'ge32'` es histórico (sin C). NO RENOMBRAR — rompe report Power BI.
UNIT_TO_COLUMN: dict[str, str] = {
    "TGJ1":  "tgj1",
    "TGJ2":  "tgj2",
    "GEC3":  "gec3",
    "GEC32": "ge32",
}

# Schema explícito de la tabla — debe coincidir con el del notebook actual.
TABLE_SCHEMA = pa.schema([
    ("id_date",   pa.int64()),
    ("hourx",     pa.int64()),
    ("minutex",   pa.int64()),
    ("secondx",   pa.int64()),
    ("tgj1",      pa.float64()),
    ("tgj2",      pa.float64()),
    ("gec3",      pa.float64()),
    ("ge32",      pa.float64()),  # ⚠️ sin C, histórico
    ("uom",       pa.string()),
    ("descript",  pa.string()),
    ("ts_concat", pa.int64()),
])

_BOGOTA_TZ = timezone(timedelta(hours=-5))


def now_bogota_utc5() -> datetime:
    """Hora actual en zona Bogotá (UTC-5, sin DST).

    Usamos offset fijo en lugar de `zoneinfo.ZoneInfo("America/Bogota")` para
    evitar dependencia del paquete `tzdata` en Windows. Bogotá no observa DST
    así que el offset es estable.
    """
    return datetime.now(_BOGOTA_TZ)


def build_row(units_payload: list[dict], now_bogota: datetime) -> dict[str, Any]:
    """Construye una fila Fabric a partir del payload del MeterPoller.

    Las unidades sin dato (`value_kw is None`) se persisten como `0.0` —
    el report Power BI espera numéricos, no NULL/NaN.

    ⚠️ La columna para GEC32 se llama `ge32` (sin C). Histórico, NO renombrar.
    """
    id_date = int(now_bogota.strftime("%Y%m%d"))
    ts_concat = int(now_bogota.strftime("%Y%m%d%H%M%S"))

    row: dict[str, Any] = {
        "id_date":   id_date,
        "hourx":     now_bogota.hour,
        "minutex":   now_bogota.minute,
        "secondx":   now_bogota.second,
        "tgj1":      0.0,
        "tgj2":      0.0,
        "gec3":      0.0,
        "ge32":      0.0,  # ⚠️ sin C, histórico
        "uom":       "KW",
        "descript":  "Potencia",
        "ts_concat": ts_concat,
    }
    for unit in units_payload:
        column = UNIT_TO_COLUMN.get(unit.get("id"))
        if column is None:
            continue
        value_kw = unit.get("value_kw")
        if value_kw is None:
            continue  # mantener 0.0
        row[column] = float(value_kw)
    return row


class FabricWriter:
    """Escritor de Delta en OneLake con cache de tokens por scope.

    Tokens cacheados independientemente para:
      - `https://storage.azure.com/.default` (writes a OneLake / abfss)
      - `https://api.fabric.microsoft.com/.default` (refresh del SQL endpoint,
        listar lakehouses, etc.)

    Son tokens distintos. `azure-identity` ya cachea internamente; el cache
    propio de esta clase es defensa en profundidad y deja explícito el margen
    de renovación de 60 s antes de la expiración.
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        workspace_id: str,
        lakehouse_name: str,
        table_name: str,
        schema: str | None = None,
    ) -> None:
        if not all([tenant_id, client_id, client_secret, workspace_id, lakehouse_name, table_name]):
            raise ValueError(
                "FabricWriter: tenant_id, client_id, client_secret, workspace_id, "
                "lakehouse_name y table_name son requeridos"
            )
        self._credential = ClientSecretCredential(tenant_id, client_id, client_secret)
        self.workspace_id = workspace_id
        self.lakehouse_name = lakehouse_name
        self.table_name = table_name
        # Convertir string vacío en None para uso uniforme aguas abajo.
        self.schema: str | None = schema or None
        self._token_cache: dict[str, tuple[str, float]] = {}

    def _get_token(self, scope: str) -> str:
        cached = self._token_cache.get(scope)
        if cached is not None:
            token, expires_on = cached
            if expires_on - time.time() > _TOKEN_REFRESH_MARGIN_S:
                return token
        access = self._credential.get_token(scope)
        self._token_cache[scope] = (access.token, float(access.expires_on))
        return access.token

    def get_storage_options(self) -> dict[str, str]:
        return {
            "bearer_token": self._get_token(STORAGE_SCOPE),
            "use_fabric_endpoint": "true",
        }

    def get_table_path(self) -> str:
        # Si el tenant tiene `FriendlyNameSupportDisabled`, hay que usar el GUID
        # del Lakehouse en lugar del displayName (sin el sufijo ".Lakehouse").
        # Detectamos GUID por formato y omitimos el sufijo automáticamente —
        # así el `.env` puede tener ID o nombre indistintamente.
        if _GUID_RE.match(self.lakehouse_name):
            artifact = self.lakehouse_name
        else:
            artifact = f"{self.lakehouse_name}.Lakehouse"
        base = (
            f"abfss://{self.workspace_id}@onelake.dfs.fabric.microsoft.com/"
            f"{artifact}/Tables"
        )
        if self.schema:
            return f"{base}/{self.schema}/{self.table_name}"
        return f"{base}/{self.table_name}"

    def write_overwrite(self, rows: list[dict[str, Any]]) -> None:
        """Escribe filas en modo overwrite con schema explícito.

        Usa `schema_mode='overwrite'` para que la primera escritura cree la
        tabla con el schema correcto y reemplace cualquier schema previo
        incompatible (ej. tabla creada por el notebook viejo con tipos distintos).
        """
        if not rows:
            raise ValueError("FabricWriter.write_overwrite: rows vacío")
        table = pa.Table.from_pylist(rows, schema=TABLE_SCHEMA)
        write_deltalake(
            self.get_table_path(),
            table,
            mode="overwrite",
            schema_mode="overwrite",
            storage_options=self.get_storage_options(),
        )

    def vacuum(self, retain_hours: int = 0) -> int:
        """Mantenimiento: borra archivos físicos antiguos.

        Equivalente al `VACUUM ... RETAIN 0 HOURS` del notebook. Devuelve la
        cantidad de archivos eliminados (best-effort, log en caso de error).
        """
        try:
            dt = DeltaTable(
                self.get_table_path(),
                storage_options=self.get_storage_options(),
            )
            deleted = dt.vacuum(
                retention_hours=retain_hours,
                enforce_retention_duration=False,
                dry_run=False,
            )
            count = len(deleted) if deleted is not None else 0
            logger.info("vacuum eliminó %d archivos", count)
            return count
        except Exception as exc:
            logger.warning("vacuum falló: %s: %s", type(exc).__name__, exc)
            return 0

    def refresh_sql_endpoint(self, sql_endpoint_id: str) -> bool:
        """POST /refreshMetadata al SQL Analytics endpoint del Lakehouse.

        Best-effort — nunca lanza. El sync de background de Fabric eventualmente
        sincroniza igual; este refresh sólo lo acelera.
        """
        url = (
            f"https://api.fabric.microsoft.com/v1/workspaces/{self.workspace_id}"
            f"/sqlEndpoints/{sql_endpoint_id}/refreshMetadata"
        )
        try:
            token = self._get_token(FABRIC_API_SCOPE)
            response = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                timeout=60,
            )
            if response.status_code in (200, 202):
                logger.info(
                    "refresh_sql_endpoint OK (%s) endpoint=%s",
                    response.status_code, sql_endpoint_id,
                )
                return True
            logger.warning(
                "refresh_sql_endpoint HTTP %s endpoint=%s: %s",
                response.status_code, sql_endpoint_id, response.text[:200],
            )
            return False
        except Exception as exc:
            logger.warning("refresh_sql_endpoint falló: %s: %s", type(exc).__name__, exc)
            return False
