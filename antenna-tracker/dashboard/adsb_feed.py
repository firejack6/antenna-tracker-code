#!/usr/bin/env python3
"""Local ADS-B → relay TRACK TARGET (USB SDR via dump1090/readsb, or SBS TCP).

Typical USB path on the dashboard host:
  RTL-SDR / FA stick → dump1090 or readsb (--net) → this script

Sources:
  json  dump1090/readsb aircraft.json (default http://127.0.0.1:8080/data/aircraft.json)
  sbs   BaseStation TCP (default 127.0.0.1:30003)

  python adsb_feed.py a1b2c3 --lat 41.88 --lon -87.63
  python adsb_feed.py a1b2c3 --source json --url http://127.0.0.1:8080/data/aircraft.json
  python adsb_feed.py a1b2c3 --source sbs --host 127.0.0.1 --port 30003
"""
from __future__ import annotations

import argparse
import json
import math
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from track_sim import bearing_range_el  # noqa: E402

ICAO_RE = re.compile(r"^[0-9a-fA-F]{6}$")
FT_TO_M = 0.3048


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


def _ui_idle_s(relay: str) -> float | None:
    try:
        req = urllib.request.Request(f"{relay.rstrip('/')}/api/ui-idle", method="GET")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
        idle = payload.get("idle_s")
        return float(idle) if isinstance(idle, (int, float)) and math.isfinite(idle) else None
    except Exception:
        return None


def _finite(*vals: float) -> bool:
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals)


def _alt_m(ac: dict) -> float | None:
    for key in ("alt_baro", "alt_geom", "altitude", "alt"):
        v = ac.get(key)
        if isinstance(v, (int, float)) and math.isfinite(v):
            # dump1090 JSON altitudes are feet; SBS MSG alt is also feet.
            return float(v) * FT_TO_M
    return None


def fetch_json(url: str, icao24: str) -> dict | None:
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    with urllib.request.urlopen(req, timeout=3.0) as resp:
        payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    aircraft = payload.get("aircraft") or payload.get("ac") or []
    want = icao24.lower()
    for ac in aircraft:
        hex_id = str(ac.get("hex") or ac.get("icao") or ac.get("icao24") or "").lower()
        if hex_id != want:
            continue
        lat, lon = ac.get("lat"), ac.get("lon")
        if not _finite(lat, lon):
            return None
        alt = _alt_m(ac)
        if alt is None:
            alt = 0.0
        cs = str(ac.get("flight") or ac.get("callsign") or hex_id).strip() or hex_id
        return {
            "icao24": want,
            "callsign": cs,
            "lat": float(lat),
            "lon": float(lon),
            "alt": float(alt),
            "on_ground": bool(ac.get("ground") or ac.get("on_ground") or False),
            "track": float(ac["track"]) if isinstance(ac.get("track"), (int, float)) else None,
            "seen": ac.get("seen") or ac.get("seen_pos"),
        }
    return None


class SbsWatcher:
    """Keep last lat/lon/alt per ICAO from a BaseStation TCP stream."""

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = int(port)
        self._sock: socket.socket | None = None
        self._buf = ""
        self._latest: dict[str, dict] = {}
        self._last_err = ""

    def _connect(self) -> None:
        if self._sock:
            return
        sock = socket.create_connection((self.host, self.port), timeout=3.0)
        sock.settimeout(0.2)
        self._sock = sock
        self._buf = ""
        self._last_err = ""

    def close(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None

    def poll(self, icao24: str) -> dict | None:
        want = icao24.lower()
        try:
            self._connect()
            assert self._sock is not None
            while True:
                try:
                    chunk = self._sock.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    self.close()
                    break
                self._buf += chunk.decode("utf-8", errors="replace")
                while "\n" in self._buf:
                    line, self._buf = self._buf.split("\n", 1)
                    self._ingest(line.strip())
        except OSError as exc:
            self._last_err = str(exc)
            self.close()
        return self._latest.get(want)

    def _ingest(self, line: str) -> None:
        # MSG,transmission_type,...,hex,...,callsign,...,altitude,...,lat,lon,...
        if not line.startswith("MSG,"):
            return
        parts = line.split(",")
        if len(parts) < 16:
            return
        hex_id = parts[4].strip().lower()
        if not ICAO_RE.match(hex_id):
            return
        cur = self._latest.get(hex_id) or {
            "icao24": hex_id,
            "callsign": hex_id,
            "lat": None,
            "lon": None,
            "alt": None,
            "on_ground": False,
            "track": None,
        }
        cs = parts[10].strip()
        if cs:
            cur["callsign"] = cs
        try:
            if parts[11].strip() != "":
                cur["alt"] = float(parts[11]) * FT_TO_M
        except ValueError:
            pass
        try:
            if parts[14].strip() != "" and parts[15].strip() != "":
                cur["lat"] = float(parts[14])
                cur["lon"] = float(parts[15])
        except ValueError:
            pass
        try:
            if parts[13].strip() != "":
                cur["track"] = float(parts[13])
        except ValueError:
            pass
        self._latest[hex_id] = cur


def run(
    icao24: str,
    relay: str,
    home_lat: float,
    home_lon: float,
    home_alt: float,
    decl: float,
    interval_s: float,
    idle_stop_s: float,
    source: str,
    url: str,
    host: str,
    port: int,
    observe: bool = False,
) -> int:
    icao24 = icao24.strip().lower()
    if not ICAO_RE.match(icao24):
        _emit({"event": "error", "message": "icao24 must be 6 hex chars"})
        return 2

    source = (source or "json").strip().lower()
    if source not in ("json", "sbs"):
        _emit({"event": "error", "message": "source must be json or sbs"})
        return 2

    relay = relay.rstrip("/")
    target_url = f"{relay}/api/track-target"
    interval_s = max(0.25, float(interval_s))
    idle_stop_s = max(60.0, float(idle_stop_s))
    pointing = not observe
    sbs = SbsWatcher(host, port) if source == "sbs" else None

    src_label = url if source == "json" else f"sbs://{host}:{port}"
    _emit(
        {
            "event": "start",
            "active": True,
            "file": f"adsb:{icao24}",
            "icao24": icao24,
            "index": 0,
            "n": 0,
            "t": 0.0,
            "duration_s": 0.0,
            "interval_s": interval_s,
            "pointing": pointing,
            "message": (
                f"adsb {icao24} every {interval_s:g}s · {src_label}"
                + (" · observe only" if observe else " · pointing")
                + f" · stop if UI idle {idle_stop_s:.0f}s"
            ),
        }
    )

    t0 = time.monotonic()
    sent = misses = errors = n = 0

    try:
        while True:
            idle = _ui_idle_s(relay)
            if idle is not None and idle >= idle_stop_s:
                _emit(
                    {
                        "event": "done",
                        "active": False,
                        "file": f"adsb:{icao24}",
                        "icao24": icao24,
                        "sent": sent,
                        "misses": misses,
                        "errors": errors,
                        "message": f"adsb stopped — dashboard idle {idle:.0f}s (≥{idle_stop_s:.0f}s)",
                    }
                )
                return 0

            loop_start = time.monotonic()
            n += 1
            ac = None
            try:
                if source == "json":
                    ac = fetch_json(url, icao24)
                else:
                    assert sbs is not None
                    raw = sbs.poll(icao24)
                    if raw and _finite(raw.get("lat"), raw.get("lon")):
                        ac = {
                            **raw,
                            "alt": float(raw["alt"]) if isinstance(raw.get("alt"), (int, float)) else 0.0,
                            "on_ground": False,
                        }
                    elif sbs._last_err and not sbs._sock:
                        raise OSError(sbs._last_err or "SBS disconnected")
            except Exception as exc:  # noqa: BLE001
                errors += 1
                _emit(
                    {
                        "event": "error",
                        "active": True,
                        "file": f"adsb:{icao24}",
                        "icao24": icao24,
                        "index": n,
                        "n": n,
                        "t": time.monotonic() - t0,
                        "sent": sent,
                        "misses": misses,
                        "errors": errors,
                        "message": f"adsb fetch: {exc}",
                    }
                )
                time.sleep(interval_s)
                continue

            if ac is None or ac.get("on_ground"):
                misses += 1
                why = "on ground" if ac and ac.get("on_ground") else "no position"
                _emit(
                    {
                        "event": "drop",
                        "active": True,
                        "file": f"adsb:{icao24}",
                        "icao24": icao24,
                        "index": n,
                        "n": n,
                        "t": time.monotonic() - t0,
                        "sent": sent,
                        "misses": misses,
                        "errors": errors,
                        "message": f"adsb {icao24} · {why}",
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
                        "file": f"adsb:{icao24}",
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
                        "message": (
                            f"adsb {ac['callsign']} {ac['lat']:.5f},{ac['lon']:.5f}"
                            f" · {ac['alt']:.0f} m · az {az:.0f}° el {el:.0f}°"
                            + (" · observe" if not pointing else " · TRACK")
                            + (f" · {message}" if message else "")
                        ),
                    }
                )

            remain = interval_s - (time.monotonic() - loop_start)
            if remain > 0:
                time.sleep(remain)
    finally:
        if sbs:
            sbs.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local ADS-B → TRACK TARGET")
    parser.add_argument("icao24", help="ICAO24 hex, e.g. a1b2c3")
    parser.add_argument("--relay", default="http://127.0.0.1:8765")
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--alt", type=float, default=0.0)
    parser.add_argument("--decl", type=float, default=0.0)
    parser.add_argument("--interval", type=float, default=1.0, help="Poll period seconds")
    parser.add_argument("--idle-stop", type=float, default=600.0)
    parser.add_argument("--observe", action="store_true")
    parser.add_argument("--source", choices=("json", "sbs"), default="json")
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8080/data/aircraft.json",
        help="dump1090/readsb aircraft.json URL (source=json)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="SBS host (source=sbs)")
    parser.add_argument("--port", type=int, default=30003, help="SBS port (source=sbs)")
    args = parser.parse_args(argv)
    try:
        return run(
            args.icao24,
            args.relay,
            float(args.lat),
            float(args.lon),
            float(args.alt or 0),
            float(args.decl),
            float(args.interval),
            float(args.idle_stop),
            args.source,
            args.url,
            args.host,
            int(args.port),
            observe=bool(args.observe),
        )
    except KeyboardInterrupt:
        _emit({"event": "done", "active": False, "message": "stopped"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
