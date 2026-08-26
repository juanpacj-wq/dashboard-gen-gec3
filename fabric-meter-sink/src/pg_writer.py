"""Escritura espejo a Azure PostgreSQL (`dl_captura`) — sink secundario.

Espeja la tabla Delta de Fabric en `generacion.brc_pgn_generacion_medidores`
con la MISMA semántica: cada ciclo escribe el buffer completo (últimas N filas)
reemplazando el contenido anterior. La tabla siempre refleja los últimos N
ciclos, igual que en Fabric.

Semántica de overwrite: `DELETE FROM` + `INSERT` en una sola transacción (no
`TRUNCATE`: DELETE no toma lock exclusivo, así los lectores concurrentes nunca
ven la tabla vacía a mitad de escritura). Con 3 filas cada 15 s el autovacuum
absorbe los dead tuples sin problema.

Conexión perezosa con self-heal: si cualquier operación falla, la conexión se
cierra y el próximo ciclo reconecta desde cero (mismo patrón que el cliente
Modbus en D-123). El DDL (CREATE SCHEMA/TABLE IF NOT EXISTS) se re-ejecuta una
vez por conexión nueva — es idempotente y barato.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$", re.IGNORECASE)

# Mismo orden que TABLE_SCHEMA de fabric_writer — las filas vienen de build_row.
# ⚠️ `ge32` sin C: histórico, espejo exacto de la columna en Fabric.
COLUMNS: tuple[str, ...] = (
    "id_date", "hourx", "minutex", "secondx",
    "tgj1", "tgj2", "gec3", "ge32",
    "uom", "descript", "ts_concat",
)


def _default_connect(**kwargs: Any) -> Any:
    import psycopg

    return psycopg.connect(**kwargs)


class PostgresWriter:
    """Escritor a Postgres con conexión perezosa y self-heal al fallar.

    `connect_fn` es inyectable para tests (default: `psycopg.connect`).
    """

    def __init__(
        self,
        *,
        host: str,
        dbname: str,
        user: str,
        password: str,
        port: int = 5432,
        schema: str = "generacion",
        table: str = "brc_pgn_generacion_medidores",
        sslmode: str = "require",
        connect_timeout_s: int = 10,
        connect_fn: Callable[..., Any] | None = None,
    ) -> None:
        if not all([host, dbname, user, password]):
            raise ValueError(
                "PostgresWriter: host, dbname, user y password son requeridos"
            )
        for name, value in (("schema", schema), ("table", table)):
            if not _IDENT_RE.match(value or ""):
                raise ValueError(
                    f"PostgresWriter: {name} inválido {value!r} — solo "
                    "identificadores simples [a-z_][a-z0-9_]*"
                )
        self.host = host
        self.port = int(port)
        self.dbname = dbname
        self.user = user
        self.password = password
        self.schema = schema
        self.table = table
        self.sslmode = sslmode
        self.connect_timeout_s = int(connect_timeout_s)
        self._connect_fn = connect_fn or _default_connect
        self._conn: Any | None = None
        self._table_ready = False

    # ── SQL (identificadores validados en __init__, interpolación segura) ──────

    @property
    def qualified_table(self) -> str:
        return f'"{self.schema}"."{self.table}"'

    def _ddl_statements(self) -> tuple[str, str]:
        return (
            f'CREATE SCHEMA IF NOT EXISTS "{self.schema}"',
            f"""CREATE TABLE IF NOT EXISTS {self.qualified_table} (
                id_date    BIGINT NOT NULL,
                hourx      BIGINT NOT NULL,
                minutex    BIGINT NOT NULL,
                secondx    BIGINT NOT NULL,
                tgj1       DOUBLE PRECISION NOT NULL,
                tgj2       DOUBLE PRECISION NOT NULL,
                gec3       DOUBLE PRECISION NOT NULL,
                ge32       DOUBLE PRECISION NOT NULL,
                uom        TEXT NOT NULL,
                descript   TEXT NOT NULL,
                ts_concat  BIGINT NOT NULL
            )""",
        )

    def _insert_sql(self) -> str:
        cols = ", ".join(COLUMNS)
        placeholders = ", ".join(["%s"] * len(COLUMNS))
        return f"INSERT INTO {self.qualified_table} ({cols}) VALUES ({placeholders})"

    @staticmethod
    def row_to_tuple(row: dict[str, Any]) -> tuple:
        """Fila de build_row → tupla en el orden de COLUMNS."""
        return tuple(row[c] for c in COLUMNS)

    # ── Conexión ──────────────────────────────────────────────────────────────

    def _get_conn(self) -> Any:
        if self._conn is None or getattr(self._conn, "closed", True):
            self._conn = self._connect_fn(
                host=self.host,
                port=self.port,
                dbname=self.dbname,
                user=self.user,
                password=self.password,
                sslmode=self.sslmode,
                connect_timeout=self.connect_timeout_s,
                application_name="fabric-meter-sink",
            )
            self._conn.autocommit = False
            self._table_ready = False
            logger.info(
                "PostgresWriter: conectado a %s:%d/%s", self.host, self.port, self.dbname
            )
        return self._conn

    def _reset_conn(self) -> None:
        conn, self._conn = self._conn, None
        self._table_ready = False
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _ensure_table(self, conn: Any) -> None:
        if self._table_ready:
            return
        with conn.cursor() as cur:
            for stmt in self._ddl_statements():
                cur.execute(stmt)
        conn.commit()
        self._table_ready = True

    # ── API pública (misma forma que FabricWriter) ────────────────────────────

    def write_overwrite(self, rows: list[dict[str, Any]]) -> None:
        """Reemplaza el contenido de la tabla por `rows`, transaccional.

        Ante cualquier error cierra la conexión (el próximo ciclo reconecta)
        y re-lanza — el caller decide qué hacer con el fallo.
        """
        if not rows:
            raise ValueError("PostgresWriter.write_overwrite: rows vacío")
        try:
            conn = self._get_conn()
            self._ensure_table(conn)
            with conn.cursor() as cur:
                cur.execute(f"DELETE FROM {self.qualified_table}")
                cur.executemany(
                    self._insert_sql(),
                    [self.row_to_tuple(r) for r in rows],
                )
            conn.commit()
        except Exception:
            self._reset_conn()
            raise

    def close(self) -> None:
        self._reset_conn()
