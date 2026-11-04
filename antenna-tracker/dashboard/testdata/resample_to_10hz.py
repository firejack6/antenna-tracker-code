#!/usr/bin/env python3
"""Resample OpenRocket-style CSV (t,alt,lat,lon,...) to a 10 Hz JSON track."""
from __future__ import annotations

import json
import sys
from pathlib import Path

HZ = 10


def load_rows(path: Path) -> list[tuple[float, float, float, float]]:
    rows: list[tuple[float, float, float, float]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split(",")
        if len(parts) < 4:
            continue
        try:
            t, alt, lat, lon = map(float, parts[:4])
        except ValueError:
            continue
        rows.append((t, alt, lat, lon))
    rows.sort(key=lambda r: r[0])
    if len(rows) < 2:
        raise SystemExit(f"Need >= 2 samples in {path}")
    return rows


def resample(rows: list[tuple[float, float, float, float]], hz: float = HZ) -> list[dict]:
    t0, t1 = rows[0][0], rows[-1][0]
    out: list[dict] = []
    i = 0
    t = t0
    step = 1.0 / hz
    while t <= t1 + 1e-9:
        while i + 1 < len(rows) and rows[i + 1][0] < t:
            i += 1
        if i + 1 >= len(rows) or rows[i][0] == rows[i + 1][0]:
            _, alt, lat, lon = rows[i]
        else:
            a, b = rows[i], rows[i + 1]
            u = (t - a[0]) / (b[0] - a[0])
            alt = a[1] + u * (b[1] - a[1])
            lat = a[2] + u * (b[2] - a[2])
            lon = a[3] + u * (b[3] - a[3])
        out.append(
            {
                "t": round(t - t0, 3),
                "alt": round(alt, 3),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
            }
        )
        t += step
    if out[-1]["t"] < t1 - t0 - 1e-6:
        _, alt, lat, lon = rows[-1]
        out.append(
            {
                "t": round(t1 - t0, 3),
                "alt": round(alt, 3),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
            }
        )
    return out


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("testdata1.csv"))
    dst = Path(sys.argv[2] if len(sys.argv) > 2 else src.with_name(src.stem + "_10hz.json"))
    rows = load_rows(src)
    points = resample(rows)
    payload = {
        "name": src.stem,
        "source": src.name,
        "hz": HZ,
        "duration_s": round(rows[-1][0] - rows[0][0], 3),
        "pad": {"lat": rows[0][2], "lon": rows[0][3], "alt0": rows[0][1]},
        "notes": "Altitude AGL meters. Playback time t starts at 0.",
        "points": points,
    }
    dst.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {dst} · {len(points)} points · {payload['duration_s']} s")


if __name__ == "__main__":
    main()
