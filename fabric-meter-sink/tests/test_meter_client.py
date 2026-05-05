from __future__ import annotations

import math
from pathlib import Path

import httpx
import pytest

from src.meter_client import (
    ION8650Client,
    MeterAuthError,
    MeterFormatError,
    MeterHttpError,
    MeterTimeoutError,
    parse_kw_total,
)

FIXTURE_HTML = (
    Path(__file__).parent / "fixtures" / "ion8650_op.html"
).read_text(encoding="utf-8")


# ──────────────────────────────────────────────────────────────────────────────
# parse_kw_total
# ──────────────────────────────────────────────────────────────────────────────


def test_parse_extracts_5240_04_from_real_fixture():
    assert parse_kw_total(FIXTURE_HTML) == 5240.04


def test_parse_raises_when_kw_total_label_missing():
    html = (
        '<html><body><table>'
        '<tr><td class="l">Vln avg</td><td class="v">100 V</td></tr>'
        '</table></body></html>'
    )
    with pytest.raises(MeterFormatError):
        parse_kw_total(html)


def test_parse_raises_when_unit_is_wrong():
    html = (
        '<html><body><table>'
        '<tr><td class="l">kW total</td><td class="v">5240.04 MW</td></tr>'
        '</table></body></html>'
    )
    with pytest.raises(MeterFormatError):
        parse_kw_total(html)


def test_parse_raises_when_value_is_non_numeric():
    html = (
        '<html><body><table>'
        '<tr><td class="l">kW total</td><td class="v">--- kW</td></tr>'
        '</table></body></html>'
    )
    with pytest.raises(MeterFormatError):
        parse_kw_total(html)


def test_parse_accepts_zero_kw():
    html = (
        '<html><body><table>'
        '<tr><td class="l">kW total</td><td class="v">0.00 kW</td></tr>'
        '</table></body></html>'
    )
    assert parse_kw_total(html) == 0.0


def test_parse_accepts_negative_values():
    html = (
        '<html><body><table>'
        '<tr><td class="l">kW total</td><td class="v">-5.5 kW</td></tr>'
        '</table></body></html>'
    )
    assert parse_kw_total(html) == -5.5


def test_parse_takes_first_matching_label_when_duplicated():
    html = (
        '<html><body><table>'
        '<tr><td class="l">kW total</td><td class="v">100.00 kW</td></tr>'
        '<tr><td class="l">kW total</td><td class="v">200.00 kW</td></tr>'
        '</table></body></html>'
    )
    assert parse_kw_total(html) == 100.0


# ──────────────────────────────────────────────────────────────────────────────
# ION8650Client constructor
# ──────────────────────────────────────────────────────────────────────────────


def test_constructor_rejects_missing_host():
    with pytest.raises(TypeError):
        ION8650Client(host="", user="u", password="p")


def test_constructor_rejects_missing_user():
    with pytest.raises(TypeError):
        ION8650Client(host="h", user="", password="p")


def test_constructor_rejects_missing_password_but_accepts_empty_string():
    with pytest.raises(TypeError):
        ION8650Client(host="h", user="u", password=None)
    # Empty-string password debe ser válido (es lo que hace Buffer.from('') en JS)
    client = ION8650Client(host="h", user="u", password="")
    client.close()


def test_constructor_accepts_host_with_explicit_scheme():
    client = ION8650Client(host="http://10.0.0.1/", user="u", password="p")
    assert client.url == "http://10.0.0.1/Operation.html"
    client.close()


def test_constructor_prefixes_http_when_scheme_missing():
    client = ION8650Client(host="10.0.0.1", user="u", password="p")
    assert client.url == "http://10.0.0.1/Operation.html"
    client.close()


# ──────────────────────────────────────────────────────────────────────────────
# ION8650Client.fetch_kw_total — mocked HTTP via httpx.MockTransport
# ──────────────────────────────────────────────────────────────────────────────


def _client_with_handler(handler, **kwargs):
    transport = httpx.MockTransport(handler)
    return ION8650Client(transport=transport, **kwargs)


def test_fetch_returns_kw_and_metadata_on_200_with_basic_auth():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["url"] = str(request.url)
        return httpx.Response(200, text=FIXTURE_HTML)

    client = _client_with_handler(
        handler, host="192.168.200.2", user="user1", password="4816"
    )
    try:
        result = client.fetch_kw_total()
    finally:
        client.close()

    assert result["kw"] == 5240.04
    assert isinstance(result["fetched_at"], str)
    assert isinstance(result["latency_ms"], int)
    # Basic auth: base64('user1:4816')
    import base64

    expected = "Basic " + base64.b64encode(b"user1:4816").decode()
    assert captured["auth"] == expected
    assert captured["url"] == "http://192.168.200.2/Operation.html"


def test_fetch_raises_meter_auth_error_on_401():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    client = _client_with_handler(
        handler, host="10.0.0.1", user="u", password="bad"
    )
    try:
        with pytest.raises(MeterAuthError):
            client.fetch_kw_total()
    finally:
        client.close()


def test_fetch_raises_meter_http_error_on_500():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="oops")

    client = _client_with_handler(
        handler, host="10.0.0.1", user="u", password="p"
    )
    try:
        with pytest.raises(MeterHttpError):
            client.fetch_kw_total()
    finally:
        client.close()


def test_fetch_raises_format_error_when_html_missing_kw_total():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html><body>nothing here</body></html>")

    client = _client_with_handler(
        handler, host="10.0.0.1", user="u", password="p"
    )
    try:
        with pytest.raises(MeterFormatError):
            client.fetch_kw_total()
    finally:
        client.close()


def test_fetch_raises_meter_timeout_error_on_timeout():
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("simulated", request=None)

    client = _client_with_handler(
        handler, host="10.0.0.1", user="u", password="p", timeout_s=1.0
    )
    try:
        with pytest.raises(MeterTimeoutError):
            client.fetch_kw_total()
    finally:
        client.close()


def test_fetch_respects_custom_op_path():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        return httpx.Response(200, text=FIXTURE_HTML)

    client = _client_with_handler(
        handler, host="10.0.0.1", user="u", password="p", op_path="/Custom/Page.html"
    )
    try:
        result = client.fetch_kw_total()
    finally:
        client.close()
    assert captured["path"] == "/Custom/Page.html"
    assert result["kw"] == 5240.04


def test_fetch_accepts_host_with_explicit_http_scheme():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=FIXTURE_HTML)

    client = _client_with_handler(
        handler, host="http://10.0.0.1/", user="u", password="p"
    )
    try:
        result = client.fetch_kw_total()
    finally:
        client.close()
    assert result["kw"] == 5240.04


def test_finite_kw_assumption_holds():
    """Sanity: parse_kw_total nunca devuelve nan/inf con entrada válida."""
    assert math.isfinite(parse_kw_total(FIXTURE_HTML))
