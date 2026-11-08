#!/usr/bin/env python3
"""Realtime lat/lon/alt feeder — separate process, like a radio→host decoder.

Paces each flight sample to wall clock with no inter-sample sleep cap. Gaps in
the file are true silence (no TARGET packets), so onboard SEARCH_GAP can fire.

Default path: HTTP POST /api/track-target on the dashboard relay (host bridges
to the dish over the existing Wi‑Fi/TCP link). That mirrors the field shape:

  radio/serial → this process → relay → TRACK TARGET → ESP32

CLI:
  python radio_feed.py copper45-gap10s.csv
  python radio_feed.py copper45-gap10s.csv --relay http://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Reuse flight parsers / geometry from track_sim (same package dir).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from track_sim import (  # noqa: E402
    TESTDATA,
    _safe_name,
    bearing_range_el,
    load_flight,
    load_home,
)


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


def _emit(status: dict) -> None:
    """One JSON object per line on stdout for the parent TrackSim reader."""
    sys.stdout.write(json.dumps(status, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def run(
    file_name: str,
    relay: str,
    home_lat: float,
    home_lon: float,
    home_alt: float,
    decl: float,
    pan_align: float,
    pan_invert: bool,
    speed: float,
) -> int:
    name = _safe_name(file_name)
    samples = load_flight(name)
    if len(samples) < 2:
        _emit({"event": "error", "message": f"{name}: need >= 2 samples"})
        return 2

    relay = relay.rstrip("/")
    target_url = f"{relay}/api/track-target"
    duration = samples[-1]["t"] - samples[0]["t"]
    t_flight0 = samples[0]["t"]
    speed = max(0.05, float(speed))

    _emit(
        {
            "event": "start",
            "active": True,
            "file": name,
            "index": 0,
            "n": len(samples),
            "t": 0.0,
            "duration_s": duration,
            "message": f"radio-feed {name} ({len(samples)} pts, {duration:.1f}s realtime ×{speed:g})",
        }
    )

    t_wall0 = time.monotonic()
    sent = 0
    blocked = 0
    errors = 0

    for i, p in enumerate(samples):
        # True wall-clock wait — gaps are real silence (no catch-up / no 2s cap).
        due = t_wall0 + (p["t"] - t_flight0) / speed
        while True:
            remain = due - time.monotonic()
            if remain <= 0:
                break
            time.sleep(min(remain, 0.05))

        az, el, rng, _slant = bearing_range_el(
            home_lat, home_lon, home_alt, p["lat"], p["lon"], p["alt"]
        )
        # Mag track frame: commanded pan = magnetic heading (true − decl).
        # pan_align / pan_invert are ignored (pot-era leftovers).
        az_mag = (az - decl + 360.0) % 360.0
        pan = ((az_mag + 180.0) % 360.0) - 180.0
        _ = pan_align, pan_invert

        ok = False
        message = ""
        try:
            _post_json(
                target_url,
                {"lat": p["lat"], "lon": p["lon"], "alt": p["alt"]},
                timeout=2.0,
            )
            ok = True
            sent += 1
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            message = body.strip() or f"HTTP {exc.code}"
            if exc.code in (400, 409) and "enable" in message.lower():
                blocked += 1
            else:
                errors += 1
        except Exception as exc:  # noqa: BLE001 — keep feeding; report
            message = str(exc)
            errors += 1

        gap_ahead = 0.0
        if i + 1 < len(samples):
            gap_ahead = (samples[i + 1]["t"] - p["t"]) / speed

        _emit(
            {
                "event": "fix" if ok else "drop",
                "active": True,
                "file": name,
                "index": i + 1,
                "n": len(samples),
                "t": p["t"] - t_flight0,
                "duration_s": duration,
                "lat": p["lat"],
                "lon": p["lon"],
                "alt": p["alt"],
                "az": az,
                "el": el,
                "range_m": rng,
                "pan": pan,
                "gap_ahead_s": round(gap_ahead, 3),
                "sent": sent,
                "blocked": blocked,
                "errors": errors,
                "message": (
                    f"radio {name} {i + 1}/{len(samples)} t={p['t'] - t_flight0:.2f}s"
                    + (f" · next gap {gap_ahead:.1f}s" if gap_ahead >= 1.0 else "")
                    + (f" · {message}" if message else "")
                ),
            }
        )

    _emit(
        {
            "event": "done",
            "active": False,
            "file": name,
            "index": len(samples),
            "n": len(samples),
            "t": duration,
            "duration_s": duration,
            "sent": sent,
            "blocked": blocked,
            "errors": errors,
            "message": f"done {name}: sent={sent} blocked={blocked} errors={errors}",
        }
    )
    return 0 if errors == 0 else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Realtime radio-like lat/lon/alt feed into the dashboard relay."
    )
    parser.add_argument(
        "file",
        nargs="?",
        default="copper45-gap10s.csv",
        help="Flight file under dashboard/testdata/",
    )
    parser.add_argument(
        "--relay",
        default="http://127.0.0.1:8765",
        help="Dashboard relay base URL (default http://127.0.0.1:8765)",
    )
    parser.add_argument("--lat", type=float, default=None, help="Site lat (else *.home.json)")
    parser.add_argument("--lon", type=float, default=None, help="Site lon (else *.home.json)")
    parser.add_argument("--alt", type=float, default=None, help="Site alt m (else *.home.json)")
    parser.add_argument("--decl", type=float, default=0.0, help="Mag declination deg")
    parser.add_argument("--pan-align", type=float, default=0.0, help="Pan align deg")
    parser.add_argument("--pan-invert", action="store_true", help="Invert pan")
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Playback rate (1=realtime; gaps scale with this)",
    )
    args = parser.parse_args(argv)

    home = load_home(args.file) or {}
    lat = args.lat if args.lat is not None else home.get("lat")
    lon = args.lon if args.lon is not None else home.get("lon")
    alt = args.alt if args.alt is not None else home.get("alt", 0.0)
    if lat is None or lon is None:
        print(
            f"error: need --lat/--lon or {args.file}.home.json under {TESTDATA}",
            file=sys.stderr,
        )
        return 2

    return run(
        args.file,
        args.relay,
        float(lat),
        float(lon),
        float(alt or 0),
        float(args.decl),
        float(args.pan_align),
        bool(args.pan_invert),
        float(args.speed),
    )


if __name__ == "__main__":
    raise SystemExit(main())
