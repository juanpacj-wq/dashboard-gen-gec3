"""HTTP client for Schneider PowerLogic ION8650 meters.

Port directo de `server/meterClient.js`. Lee la página `/Operation.html` del
medidor con HTTP Basic Auth y extrae el valor de la celda `kW total` con regex.

El medidor reporta `kW total` desde la perspectiva del punto físico donde está
instalado — la convención de signos se aplica más arriba en `meter_poller.py`,
no aquí. Aquí el cero y los negativos se aceptan como datos válidos.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import TypedDict

import httpx
from bs4 import BeautifulSoup

DEFAULT_OP_PATH = "/Operation.html"
DEFAULT_TIMEOUT_S = 4.0
KW_LABEL = "kW total"

_KW_VALUE_RE = re.compile(r"^(-?\d+(?:\.\d+)?)\s*kW$")
_SCHEME_RE = re.compile(r"^https?://", re.IGNORECASE)


class MeterReading(TypedDict):
    kw: float
    fetched_at: str
    latency_ms: int


class MeterError(Exception):
    """Base class for meter errors. Carries the host that failed."""

    def __init__(self, message: str, *, host: str | None = None) -> None:
        super().__init__(message)
        self.host = host


class MeterAuthError(MeterError):
    """HTTP 401."""


class MeterHttpError(MeterError):
    """Other 4xx/5xx."""


class MeterTimeoutError(MeterError):
    """httpx timeout (connect, read, or total)."""


class MeterFormatError(MeterError):
    """200 OK but the HTML did not contain the expected `kW total` cell."""


def parse_kw_total(html: str, host: str = "<unknown>") -> float:
    """Parse the `kW total` value out of an ION8650 Operation page.

    Looks for the first `<td class="l">kW total</td>` and reads the immediately
    adjacent `<td class="v">N.NN kW</td>`. Equivalent to cheerio's
    `td.l:contains('kW total')` + `.next('td.v')` in the Node port.
    """
    soup = BeautifulSoup(html, "html.parser")
    label = next(
        (
            td
            for td in soup.find_all("td", class_="l")
            if td.get_text(strip=True) == KW_LABEL
        ),
        None,
    )
    if label is None:
        raise MeterFormatError(
            f"Could not find label cell '{KW_LABEL}' in HTML (host={host})",
            host=host,
        )
    value_cell = label.find_next_sibling("td", class_="v")
    if value_cell is None:
        raise MeterFormatError(
            f"Label '{KW_LABEL}' present but adjacent td.v missing (host={host})",
            host=host,
        )
    text = value_cell.get_text(strip=True)
    match = _KW_VALUE_RE.match(text)
    if not match:
        raise MeterFormatError(
            f"Value '{text}' does not match '<number> kW' pattern (host={host})",
            host=host,
        )
    try:
        kw = float(match.group(1))
    except ValueError as exc:
        raise MeterFormatError(
            f"Parsed kW is not finite: '{match.group(1)}' (host={host})",
            host=host,
        ) from exc
    return kw


class ION8650Client:
    """HTTP client for one ION8650 meter."""

    def __init__(
        self,
        *,
        host: str,
        user: str,
        password: str,
        op_path: str = DEFAULT_OP_PATH,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not host:
            raise TypeError("ION8650Client: host required")
        if not user:
            raise TypeError("ION8650Client: user required")
        if password is None:
            raise TypeError("ION8650Client: password required")

        self._host = host
        self._user = user
        self._password = password
        self._op_path = op_path
        self._timeout_s = timeout_s
        self._url = self._build_url()

        client_kwargs: dict = {
            "auth": (user, password),
            "timeout": timeout_s,
        }
        if transport is not None:
            client_kwargs["transport"] = transport
        self._http = httpx.Client(**client_kwargs)

    @property
    def host(self) -> str:
        return self._host

    @property
    def url(self) -> str:
        return self._url

    def _build_url(self) -> str:
        host = self._host
        if not _SCHEME_RE.match(host):
            host = f"http://{host}"
        host = host.rstrip("/")
        path = self._op_path if self._op_path.startswith("/") else f"/{self._op_path}"
        return host + path

    def fetch_kw_total(self) -> MeterReading:
        started = time.monotonic()
        try:
            response = self._http.get(
                self._url,
                headers={"Accept": "text/html,application/xhtml+xml"},
            )
        except httpx.TimeoutException as exc:
            raise MeterTimeoutError(
                f"Timeout ({self._timeout_s}s) fetching {self._url}",
                host=self._host,
            ) from exc
        except httpx.HTTPError as exc:
            raise MeterError(
                f"Network error fetching {self._url}: {exc}",
                host=self._host,
            ) from exc

        if response.status_code == 401:
            raise MeterAuthError(
                f"401 Unauthorized at {self._url}",
                host=self._host,
            )
        if not 200 <= response.status_code < 300:
            raise MeterHttpError(
                f"HTTP {response.status_code} at {self._url}",
                host=self._host,
            )

        kw = parse_kw_total(response.text, host=self._host)
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "kw": kw,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "latency_ms": latency_ms,
        }

    def close(self) -> None:
        try:
            self._http.close()
        except Exception:
            pass

    def __enter__(self) -> ION8650Client:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
