from __future__ import annotations

import pytest

from src.pg_writer import COLUMNS, PostgresWriter

# ──────────────────────────────────────────────────────────────────────────────
# Fakes de conexión psycopg
# ──────────────────────────────────────────────────────────────────────────────


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self._conn = conn

    def execute(self, sql: str, params=None) -> None:
        if self._conn.fail_on_execute:
            raise RuntimeError("simulated pg failure")
        self._conn.executed.append((sql, params))

    def executemany(self, sql: str, seq) -> None:
        self._conn.executed.append((sql, list(seq)))

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *args) -> bool:
        return False


class FakeConn:
    def __init__(self) -> None:
        self.closed = False
        self.executed: list[tuple] = []
        self.commits = 0
        self.autocommit = None
        self.fail_on_execute = False

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        self.closed = True


def _make_writer(**overrides):
    conns: list[FakeConn] = []

    def connect_fn(**kwargs):
        conn = FakeConn()
        conn.connect_kwargs = kwargs
        conns.append(conn)
        return conn

    defaults = {
        "host": "pg.example.com",
        "dbname": "dl_captura",
        "user": "admin",
        "password": "secret",
        "connect_fn": connect_fn,
    }
    defaults.update(overrides)
    return PostgresWriter(**defaults), conns


def _row(n: float = 1.0) -> dict:
    return {
        "id_date": 20260811, "hourx": 10, "minutex": 30, "secondx": 15,
        "tgj1": n, "tgj2": 2.0, "gec3": -50.0, "ge32": -300.0,
        "uom": "KW", "descript": "Potencia", "ts_concat": 20260811103015,
    }


# ──────────────────────────────────────────────────────────────────────────────
# 1. Validación del constructor
# ──────────────────────────────────────────────────────────────────────────────


def test_missing_credentials_raises():
    with pytest.raises(ValueError, match="requeridos"):
        PostgresWriter(host="", dbname="db", user="u", password="p")


@pytest.mark.parametrize("bad", ["gen;drop", 'a"b', "1abc", "esquema con espacios", ""])
def test_invalid_identifier_raises(bad):
    with pytest.raises(ValueError, match="identificadores"):
        PostgresWriter(
            host="h", dbname="db", user="u", password="p", schema=bad,
        )


def test_defaults_target_generacion_table():
    writer, _ = _make_writer()
    assert writer.qualified_table == '"generacion"."brc_pgn_generacion_medidores"'


# ──────────────────────────────────────────────────────────────────────────────
# 2. row_to_tuple respeta el orden de COLUMNS (ge32 sin C incluida)
# ──────────────────────────────────────────────────────────────────────────────


def test_row_to_tuple_order():
    values = PostgresWriter.row_to_tuple(_row())
    assert values == (
        20260811, 10, 30, 15, 1.0, 2.0, -50.0, -300.0, "KW", "Potencia",
        20260811103015,
    )
    assert "ge32" in COLUMNS and "gec32" not in COLUMNS


# ──────────────────────────────────────────────────────────────────────────────
# 3. write_overwrite: conecta, crea schema/tabla, DELETE + INSERT, commit
# ──────────────────────────────────────────────────────────────────────────────


def test_write_overwrite_creates_table_then_replaces_rows():
    writer, conns = _make_writer()
    writer.write_overwrite([_row(1.0), _row(2.0)])

    assert len(conns) == 1
    conn = conns[0]
    assert conn.connect_kwargs["sslmode"] == "require"
    assert conn.connect_kwargs["dbname"] == "dl_captura"

    sqls = [sql for sql, _ in conn.executed]
    assert any("CREATE SCHEMA IF NOT EXISTS" in s for s in sqls)
    assert any("CREATE TABLE IF NOT EXISTS" in s for s in sqls)
    assert any(s.startswith("DELETE FROM") for s in sqls)

    insert_sql, batch = conn.executed[-1]
    assert insert_sql.startswith(
        'INSERT INTO "generacion"."brc_pgn_generacion_medidores"'
    )
    assert len(batch) == 2
    assert batch[0][4] == 1.0 and batch[1][4] == 2.0  # tgj1 por fila
    # DDL commit + write commit
    assert conn.commits == 2


def test_second_write_reuses_connection_and_skips_ddl():
    writer, conns = _make_writer()
    writer.write_overwrite([_row()])
    conns[0].executed.clear()
    writer.write_overwrite([_row()])

    assert len(conns) == 1, "no debe reconectar si la conexión sigue viva"
    sqls = [sql for sql, _ in conns[0].executed]
    assert not any("CREATE" in s for s in sqls), "DDL solo una vez por conexión"


def test_empty_rows_raises():
    writer, _ = _make_writer()
    with pytest.raises(ValueError, match="rows vacío"):
        writer.write_overwrite([])


# ──────────────────────────────────────────────────────────────────────────────
# 4. Self-heal: un fallo cierra la conexión y el próximo write reconecta
# ──────────────────────────────────────────────────────────────────────────────


def test_failure_resets_connection_and_next_write_reconnects():
    writer, conns = _make_writer()
    writer.write_overwrite([_row()])

    conns[0].fail_on_execute = True
    with pytest.raises(RuntimeError, match="simulated pg failure"):
        writer.write_overwrite([_row()])
    assert conns[0].closed, "la conexión fallida debe cerrarse"

    writer.write_overwrite([_row()])
    assert len(conns) == 2, "tras el fallo debe reconectar desde cero"
    sqls = [sql for sql, _ in conns[1].executed]
    assert any("CREATE TABLE IF NOT EXISTS" in s for s in sqls), (
        "conexión nueva re-ejecuta el DDL idempotente"
    )


def test_close_is_idempotent():
    writer, conns = _make_writer()
    writer.write_overwrite([_row()])
    writer.close()
    assert conns[0].closed
    writer.close()  # no lanza
