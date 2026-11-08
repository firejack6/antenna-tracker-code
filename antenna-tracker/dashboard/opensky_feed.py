#!/usr/bin/env python3
"""Live single-aircraft feed via OpenSky Network → relay TRACK TARGET.

Polls one ICAO24 and POSTs lat/lon/alt like radio_feed (radio→host shape).

  python opensky_feed.py a1b2c3 --lat 41.88 --lon -87.63
  python opensky_feed.py a1b2c3 --relay http://127.0.0.1:8765

Auth (optional, better credits / 5 s resolution):
  dashboard/opensky_credentials.json  OR  OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opensky_config import load_credentials  # noqa: E402
from track_sim import bearing_range_el  # noqa: E402

OPENSKY_STATES = "https://opensky-network.org/api/states/all"
OPENSKY_TOKEN = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)
ICAO_RE = re.compile(r"^[0-9a-f]{6}$")


def _emit(status: dict) -> None:
    sys.stdout.write(json.dumps(status, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _post_json(url: str, body: dict, timeout: float = 2.0) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}


class _TokenManager:
    def __init__(self, client_id: str, client_secret: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self._token: str | None = None
        self._expires_at = 0.0

    def bearer(self) -> str:
        now = time.time()
        if self._token and now < self._expires_at - 60:
            return self._token
        data = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            OPENSKY_TOKEN,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        self._token = str(payload["access_token"])
        self._expires_at = now + float(payload.get("expires_in") or 1800)
        return self._token


def _fetch_state(icao24: str, token: _TokenManager | None) -> tuple[dict | None, dict]:
    """Return (aircraft dict or None, meta with credits/http)."""
    url = f"{OPENSKY_STATES}?{urllib.parse.urlencode({'icao24': icao24})}"
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token.bearer()}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            remaining = resp.headers.get("X-Rate-Limit-Remaining")
            raw = resp.read().decode("utf-8", errors="replace")
            meta = {"http": resp.status, "credits": remaining}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        retry = exc.headers.get("X-Rate-Limit-Retry-After-Seconds") if exc.headers else None
        err = RuntimeError(
            f"OpenSky HTTP {exc.code}: {body.strip() or exc.reason}"
            + (f" · retry {retry}s" if retry else "")
        )
        err.retry_after_s = float(retry) if retry and str(retry).replace(".", "", 1).isdigit() else None  # type: ignore[attr-defined]
        err.http_status = exc.code  # type: ignore[attr-defined]
        raise err from exc

    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError("OpenSky returned non-JSON") from exc

    states = payload.get("states") or []
    if not states:
        return None, meta

    row = states[0]
    # OpenSky state vector layout (see REST docs).
    callsign = (row[1] or "").strip() if len(row) > 1 else ""
    lon = row[5] if len(row) > 5 else None
    lat = row[6] if len(row) > 6 else None
    baro = row[7] if len(row) > 7 else None
    on_ground = bool(row[8]) if len(row) > 8 else False
    track = row[10] if len(row) > 10 else None
    geo = row[13] if len(row) > 13 else None
    if lat is None or lon is None:
        return None, meta
    alt = geo if isinstance(geo, (int, float)) else baro
    if not isinstance(alt, (int, float)):
        alt = 0.0
    return {
        "icao24": icao24,
        "callsign": callsign or icao24,
        "lat": float(lat),
        "lon": float(lon),
        "alt": float(alt),
        "on_ground": on_ground,
        "track": float(track) if isinstance(track, (int, float)) else None,
        "time": payload.get("time"),
    }, meta


def _ui_idle_s(relay: str) -> float | None:
    """Seconds since last dashboard /api/state poll; None if relay unreachable."""
    try:
        req = urllib.request.Request(f"{relay}/api/ui-idle", method="GET")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
        idle = payload.get("idle_s")
        return float(idle) if idle is not None and math_isfinite(idle) else None
    except Exception:
        return None


def math_isfinite(v: float) -> bool:
    return v == v and v not in (float("inf"), float("-inf"))


def run(
    icao24: str,
    relay: str,
    home_lat: float,
    home_lon: float,
    home_alt: float,
    decl: float,
    interval_s: float,
    client_id: str | None,
    client_secret: str | None,
    idle_stop_s: float,
    observe: bool = False,
) -> int:
    icao24 = icao24.strip().lower()
    if not ICAO_RE.match(icao24):
        _emit({"event": "error", "message": "icao24 must be 6 hex chars"})
        return 2

    relay = relay.rstrip("/")
    target_url = f"{relay}/api/track-target"
    creds = load_credentials()
    cid = (client_id or creds.get("client_id") or "").strip()
    csec = (client_secret if client_secret is not None else "") or (creds.get("client_secret") or "")
    if not csec:
        csec = os.environ.get("OPENSKY_CLIENT_SECRET") or ""
    if not cid:
        cid = os.environ.get("OPENSKY_CLIENT_ID") or ""
    token = _TokenManager(cid, csec) if cid and csec else None
    # Anonymous snaps to 10 s; authenticated to 5 s — don't poll faster than that.
    min_interval = 5.0 if token else 10.0
    interval_s = max(min_interval, float(interval_s))
    idle_stop_s = max(60.0, float(idle_stop_s))
    pointing = not observe

    _emit(
        {
            "event": "start",
            "active": True,
            "file": f"opensky:{icao24}",
            "icao24": icao24,
            "index": 0,
            "n": 0,
            "t": 0.0,
            "duration_s": 0.0,
            "interval_s": interval_s,
            "pointing": pointing,
            "message": (
                f"opensky {icao24} every {interval_s:.0f}s"
                + (" · authenticated" if token else " · anonymous")
                + (" · observe only" if observe else " · pointing")
                + f" · stop if UI idle {idle_stop_s:.0f}s"
            ),
        }
    )

    t0 = time.monotonic()
    sent = 0
    misses = 0
    errors = 0
    n = 0

    while True:
        idle = _ui_idle_s(relay)
        if idle is not None and idle >= idle_stop_s:
            _emit(
                {
                    "event": "done",
                    "active": False,
                    "file": f"opensky:{icao24}",
                    "icao24": icao24,
                    "sent": sent,
                    "misses": misses,
                    "errors": errors,
                    "message": f"opensky stopped — dashboard idle {idle:.0f}s (≥{idle_stop_s:.0f}s)",
                }
            )
            return 0

        loop_start = time.monotonic()
        n += 1
        try:
            ac, meta = _fetch_state(icao24, token)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            retry_after = getattr(exc, "retry_after_s", None)
            http_status = getattr(exc, "http_status", None)
            _emit(
                {
                    "event": "error",
                    "active": True,
                    "file": f"opensky:{icao24}",
                    "icao24": icao24,
                    "index": n,
                    "n": n,
                    "t": time.monotonic() - t0,
                    "sent": sent,
                    "misses": misses,
                    "errors": errors,
                    "message": f"opensky fetch: {exc}",
                }
            )
            # 429 with a multi-hour ban: stop instead of hammering every poll interval.
            if http_status == 429 and isinstance(retry_after, (int, float)) and retry_after >= 300:
                _emit(
                    {
                        "event": "done",
                        "active": False,
                        "file": f"opensky:{icao24}",
                        "icao24": icao24,
                        "sent": sent,
                        "misses": misses,
                        "errors": errors,
                        "message": (
                            f"opensky stopped — rate limited for {retry_after:.0f}s"
                            + (" · fix Advanced credentials (was anonymous)" if not token else "")
                        ),
                    }
                )
                return 3
            if isinstance(retry_after, (int, float)) and retry_after > 0:
                time.sleep(min(float(retry_after), max(interval_s, 60.0)))
            else:
                time.sleep(interval_s)
            continue

        credits = meta.get("credits")
        if ac is None or ac.get("on_ground"):
            misses += 1
            why = "on ground" if ac and ac.get("on_ground") else "no position"
            _emit(
                {
                    "event": "drop",
                    "active": True,
                    "file": f"opensky:{icao24}",
                    "icao24": icao24,
                    "index": n,
                    "n": n,
                    "t": time.monotonic() - t0,
                    "sent": sent,
                    "misses": misses,
                    "errors": errors,
                    "credits": credits,
                    "message": f"opensky {icao24} · {why}"
                    + (f" · credits {credits}" if credits is not None else ""),
                }
            )
        else:
            az, el, rng, _slant = bearing_range_el(
                home_lat, home_lon, home_alt, ac["lat"], ac["lon"], ac["alt"]
            )
            az_mag = (az - decl + 360.0) % 360.0
            pan = ((az_mag + 180.0) % 360.0) - 180.0
            ok = True
            message = ""
            if pointing:
                try:
                    _post_json(
                        target_url,
                        {"lat": ac["lat"], "lon": ac["lon"], "alt": ac["alt"]},
                        timeout=2.0,
                    )
                    sent += 1
                except urllib.error.HTTPError as exc:
                    ok = False
                    body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
                    message = body.strip() or f"HTTP {exc.code}"
                    errors += 1
                except Exception as exc:  # noqa: BLE001
                    ok = False
                    message = str(exc)
                    errors += 1
            else:
                sent += 1

            _emit(
                {
                    "event": "fix" if ok else "drop",
                    "active": True,
                    "file": f"opensky:{icao24}",
                    "icao24": icao24,
                    "callsign": ac["callsign"],
                    "index": n,
                    "n": n,
                    "t": time.monotonic() - t0,
                    "duration_s": time.monotonic() - t0,
                    "lat": ac["lat"],
                    "lon": ac["lon"],
                    "alt": ac["alt"],
                    "az": az,
                    "el": el,
                    "range_m": rng,
                    "pan": pan,
                    "track": ac.get("track"),
                    "pointing": pointing,
                    "sent": sent,
                    "misses": misses,
                    "errors": errors,
                    "credits": credits,
                    "message": (
                        f"opensky {ac['callsign']} {ac['lat']:.5f},{ac['lon']:.5f}"
                        f" · {ac['alt']:.0f} m · az {az:.0f}° el {el:.0f}°"
                        + (" · observe" if not pointing else " · TRACK")
                        + (f" · credits {credits}" if credits is not None else "")
                        + (f" · {message}" if message else "")
                    ),
                }
            )

        remain = interval_s - (time.monotonic() - loop_start)
        if remain > 0:
            time.sleep(remain)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OpenSky single-aircraft → TRACK TARGET")
    parser.add_argument("icao24", help="ICAO24 hex, e.g. a1b2c3")
    parser.add_argument("--relay", default="http://127.0.0.1:8765")
    parser.add_argument("--lat", type=float, required=True, help="Site latitude")
    parser.add_argument("--lon", type=float, required=True, help="Site longitude")
    parser.add_argument("--alt", type=float, default=0.0, help="Site altitude m")
    parser.add_argument("--decl", type=float, default=0.0, help="Mag declination deg")
    parser.add_argument(
        "--interval",
        type=float,
        default=0.0,
        help="Poll period seconds (default 10 anonymous / 5 authenticated)",
    )
    parser.add_argument("--client-id", default="", help="Override opensky_credentials.json")
    parser.add_argument("--client-secret", default="", help="Override opensky_credentials.json")
    parser.add_argument(
        "--idle-stop",
        type=float,
        default=600.0,
        help="Stop if dashboard /api/state quiet this many seconds (default 600)",
    )
    parser.add_argument(
        "--observe",
        action="store_true",
        help="Poll + emit positions only; do not POST TRACK TARGET",
    )
    args = parser.parse_args(argv)

    creds = load_credentials()
    has_auth = bool(
        (args.client_id or creds.get("client_id"))
        and (args.client_secret or creds.get("client_secret") or os.environ.get("OPENSKY_CLIENT_SECRET"))
    )
    interval = args.interval
    if interval <= 0:
        interval = 5.0 if has_auth else 10.0

    try:
        return run(
            args.icao24,
            args.relay,
            float(args.lat),
            float(args.lon),
            float(args.alt or 0),
            float(args.decl),
            float(interval),
            args.client_id or None,
            args.client_secret or None,
            float(args.idle_stop),
            observe=bool(args.observe),
        )
    except KeyboardInterrupt:
        _emit({"event": "done", "active": False, "message": "stopped"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
