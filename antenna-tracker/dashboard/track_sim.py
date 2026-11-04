"""Replay flight track files as TRACK TARGET lat lon alt on the ESP32.

Playback uses each sample's native timestamps (wall-clock pacing). No resampling.
"""
from __future__ import annotations

import csv
import json
import math
import queue
import threading
import time
from datetime import datetime
from pathlib import Path

TESTDATA = Path(__file__).resolve().parent / "testdata"
FT_TO_M = 0.3048
MAX_INTER_SAMPLE_SLEEP_S = 2.0


def _safe_name(name: str) -> str:
    name = (name or "").strip().replace("\\", "/").split("/")[-1]
    if not name or name.startswith(".") or ".." in name:
        raise ValueError("invalid flight file name")
    return name


def _is_flight_data(path: Path) -> bool:
    name = path.name.lower()
    if name.endswith(".home.json") or name in ("sites.json",):
        return False
    return path.suffix.lower() in (".json", ".csv")


def _home_path(flight_name: str) -> Path:
    return TESTDATA / f"{_safe_name(flight_name)}.home.json"


def load_home(flight_name: str) -> dict | None:
    path = _home_path(flight_name)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        lat, lon = float(data["lat"]), float(data["lon"])
        alt = float(data.get("alt") or 0)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if not all(math.isfinite(v) for v in (lat, lon, alt)) or abs(lat) > 90 or abs(lon) > 180:
        return None
    return {
        "id": str(data.get("id") or path.name),
        "label": str(data.get("label") or _label(flight_name)),
        "lat": lat,
        "lon": lon,
        "alt": alt,
        "notes": str(data.get("notes") or ""),
        "file": _safe_name(flight_name),
    }


def list_sites() -> list[dict]:
    """Unique saved device homes from *.home.json sidecars (and optional sites.json)."""
    by_id: dict[str, dict] = {}
    sites_path = TESTDATA / "sites.json"
    if sites_path.is_file():
        try:
            raw = json.loads(sites_path.read_text(encoding="utf-8"))
            for item in raw.get("sites") or []:
                site = _normalize_site(item)
                if site:
                    by_id[site["id"]] = site
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
    if TESTDATA.is_dir():
        for path in sorted(TESTDATA.iterdir()):
            if not path.name.lower().endswith(".home.json"):
                continue
            flight = path.name[: -len(".home.json")]
            home = load_home(flight)
            if not home:
                continue
            # Prefer first label; keep flight association list
            existing = by_id.get(home["id"])
            if existing:
                flights = list(existing.get("flights") or [])
                if home["file"] not in flights:
                    flights.append(home["file"])
                existing["flights"] = flights
            else:
                by_id[home["id"]] = {
                    "id": home["id"],
                    "label": home["label"],
                    "lat": home["lat"],
                    "lon": home["lon"],
                    "alt": home["alt"],
                    "notes": home["notes"],
                    "flights": [home["file"]],
                }
    return sorted(by_id.values(), key=lambda s: s["label"].lower())


def _normalize_site(item: dict) -> dict | None:
    try:
        lat, lon = float(item["lat"]), float(item["lon"])
        alt = float(item.get("alt") or 0)
        sid = str(item.get("id") or f"{lat:.5f},{lon:.5f}")
        label = str(item.get("label") or sid)
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (lat, lon, alt)) or abs(lat) > 90 or abs(lon) > 180:
        return None
    return {
        "id": sid,
        "label": label,
        "lat": lat,
        "lon": lon,
        "alt": alt,
        "notes": str(item.get("notes") or ""),
        "flights": list(item.get("flights") or []),
    }


def list_flights() -> list[dict]:
    if not TESTDATA.is_dir():
        return []
    out: list[dict] = []
    for path in sorted(TESTDATA.iterdir()):
        if not path.is_file() or not _is_flight_data(path):
            continue
        try:
            meta = flight_meta(path.name)
        except Exception:
            continue
        if meta["points"] < 2:
            continue
        out.append(meta)
    return out


def flight_meta(name: str) -> dict:
    path = TESTDATA / _safe_name(name)
    if not path.is_file():
        raise FileNotFoundError(name)
    samples = load_flight(path.name)
    duration = samples[-1]["t"] - samples[0]["t"] if len(samples) >= 2 else 0.0
    meta = {
        "file": path.name,
        "label": _label(path.name),
        "points": len(samples),
        "duration_s": round(duration, 3),
        "fmt": samples[0].get("_fmt", "unknown"),
    }
    home = load_home(path.name)
    if home:
        meta["home"] = {
            "id": home["id"],
            "label": home["label"],
            "lat": home["lat"],
            "lon": home["lon"],
            "alt": home["alt"],
        }
    return meta


def _label(name: str) -> str:
    stem = Path(name).stem
    for junk in (" (1)", "_10hz", "_summary"):
        stem = stem.replace(junk, "")
    if stem.startswith("GPS Data - "):
        return stem[len("GPS Data - ") :]
    if stem.startswith("Altimeter Data - "):
        return stem[len("Altimeter Data - ") :]
    return stem


def load_flight(name: str) -> list[dict]:
    path = TESTDATA / _safe_name(name)
    if not path.is_file():
        raise FileNotFoundError(name)
    if path.suffix.lower() == ".json":
        return _load_json(path)
    return _load_csv(path)


def _load_json(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    pts = data.get("points") or []
    out = []
    for p in pts:
        try:
            t = float(p["t"])
            lat = float(p["lat"])
            lon = float(p["lon"])
            alt = float(p["alt"])
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"t": t, "lat": lat, "lon": lon, "alt": alt, "_fmt": "json"})
    if len(out) < 2:
        raise ValueError(f"{path.name}: need >= 2 points")
    return out


def _load_csv(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    if first.startswith("TRACKER,"):
        return _load_gps_tracker_csv(path, text)
    if first.startswith("#version,") or ",latitude,longitude," in first.lower():
        return _load_altus_csv(path, text)
    if first.lower().startswith("t,") or first.lower().startswith("time,"):
        return _load_openrocket_csv(path, text)
    # Probe: OpenRocket numeric columns without header
    try:
        return _load_openrocket_csv(path, text)
    except ValueError:
        pass
    raise ValueError(f"{path.name}: unrecognized CSV format")


def _load_openrocket_csv(path: Path, text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            t = float(parts[0])
            alt = float(parts[1])
            lat = float(parts[2])
            lon = float(parts[3])
        except ValueError:
            # header row
            continue
        out.append({"t": t, "lat": lat, "lon": lon, "alt": alt, "_fmt": "openrocket"})
    if len(out) < 2:
        raise ValueError(f"{path.name}: need >= 2 OpenRocket samples")
    return out


def _load_gps_tracker_csv(path: Path, text: str) -> list[dict]:
    """Eggtimer / custom tracker log: DATE+TIME + TRACKER Lat/Lon + Alt AGL (ft)."""
    rows = csv.DictReader(text.splitlines())
    out = []
    t0 = None
    for row in rows:
        try:
            date_s = (row.get("DATE") or "").strip()
            time_s = (row.get("TIME") or "").strip()
            lat = float(row["TRACKER Lat"])
            lon = float(row["TRACKER Lon"])
            alt_ft = float(row["Alt AGL (ft)"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(lat) or not math.isfinite(lon):
            continue
        if abs(lat) < 1e-6 and abs(lon) < 1e-6:
            continue
        try:
            dt = datetime.strptime(f"{date_s} {time_s}", "%Y-%m-%d %H:%M:%S.%f")
        except ValueError:
            try:
                dt = datetime.strptime(f"{date_s} {time_s}", "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
        ts = dt.timestamp()
        if t0 is None:
            t0 = ts
        out.append(
            {
                "t": ts - t0,
                "lat": lat,
                "lon": lon,
                "alt": alt_ft * FT_TO_M,
                "_fmt": "gps-tracker",
            }
        )
    if len(out) < 2:
        raise ValueError(f"{path.name}: need >= 2 GPS tracker samples")
    return out


def _load_altus_csv(path: Path, text: str) -> list[dict]:
    """AltusMetrum / TeleMetrum export (#version,...)."""
    lines = text.splitlines()
    header_i = next((i for i, ln in enumerate(lines) if "latitude" in ln.lower() and "longitude" in ln.lower()), None)
    if header_i is None:
        raise ValueError(f"{path.name}: no Altus header")
    rows = csv.DictReader(lines[header_i:])
    # Normalize field names (strip spaces)
    out = []
    for row in rows:
        norm = {k.strip().lower(): (v.strip() if isinstance(v, str) else v) for k, v in row.items() if k}
        try:
            t = float(norm["time"])
            lat = float(norm["latitude"])
            lon = float(norm["longitude"])
            if "height" in norm and norm["height"] not in ("", None):
                alt = float(norm["height"])
            else:
                alt = float(norm.get("altitude") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) < 1e-6:
            continue
        out.append({"t": t, "lat": lat, "lon": lon, "alt": alt, "_fmt": "altus"})
    if len(out) < 2:
        raise ValueError(f"{path.name}: need >= 2 Altus samples with GPS")
    # Shift so first sample is t=0 (Altus often starts negative pre-launch)
    t0 = out[0]["t"]
    for p in out:
        p["t"] = p["t"] - t0
    return out


def bearing_range_el(home_lat, home_lon, home_alt, lat, lon, alt):
    φ1, φ2 = math.radians(home_lat), math.radians(lat)
    dφ = math.radians(lat - home_lat)
    dλ = math.radians(lon - home_lon)
    a = math.sin(dφ / 2) ** 2 + math.cos(φ1) * math.cos(φ2) * math.sin(dλ / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))
    horiz = 6_371_000.0 * c
    y = math.sin(dλ) * math.cos(φ2)
    x = math.cos(φ1) * math.sin(φ2) - math.sin(φ1) * math.cos(φ2) * math.cos(dλ)
    az = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0
    dalt = alt - home_alt
    el = math.degrees(math.atan2(dalt, max(horiz, 1e-3)))
    rng = math.hypot(horiz, dalt)
    return az, el, rng, horiz


class TrackSim:
    def __init__(self, relay):
        self.relay = relay
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.state = {
            "active": False,
            "file": None,
            "index": 0,
            "n": 0,
            "t": 0.0,
            "duration_s": 0.0,
            "lat": None,
            "lon": None,
            "alt": None,
            "az": None,
            "el": None,
            "range_m": None,
            "pan": None,
            "message": "idle",
        }

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def _queue(self, line: str) -> bool:
        try:
            self.relay.commands.put_nowait(line.encode("ascii"))
            return True
        except queue.Full:
            return False

    def stop_sim(self, send_off: bool = True):
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=2.0)
        with self._lock:
            self.state["active"] = False
            self.state["message"] = "stopped"
            self._thread = None
        if send_off:
            self._queue("TRACK OFF\n")

    def start(self, body: dict) -> dict:
        name = _safe_name(body.get("file") or "testdata1.csv")
        samples = load_flight(name)
        home_lat = float(body["lat"])
        home_lon = float(body["lon"])
        home_alt = float(body.get("alt") or 0)
        pan_align = float(body.get("pan_align") if body.get("pan_align") is not None else 0)
        decl = float(body.get("mag_declination") or 0)
        pan_invert = bool(body.get("pan_invert"))

        self.stop_sim(send_off=False)
        self._stop.clear()
        duration = samples[-1]["t"] - samples[0]["t"]
        t_flight0 = samples[0]["t"]

        # HOME before TARGET (same as map go-to)
        self.relay.command_track_home(
            {
                "lat": home_lat,
                "lon": home_lon,
                "alt": home_alt,
                "mag_declination": decl,
                "pan_align": pan_align,
                "pan_invert": pan_invert,
            }
        )

        def run():
            with self._lock:
                self.state.update(
                    {
                        "active": True,
                        "file": name,
                        "index": 0,
                        "n": len(samples),
                        "t": 0.0,
                        "duration_s": duration,
                        "message": f"replaying {name} ({len(samples)} pts, {duration:.1f}s native)",
                    }
                )
            t_wall0 = time.monotonic()
            sent = 0
            coalesced = 0
            i = 0
            last_sent_i = -1
            while i < len(samples) and not self._stop.is_set():
                elapsed = time.monotonic() - t_wall0
                # Catch up to the sample due at this wall time (native timing, no resample)
                while i + 1 < len(samples) and (samples[i + 1]["t"] - t_flight0) <= elapsed:
                    i += 1
                    if last_sent_i >= 0:
                        coalesced += 1

                p = samples[i]
                if i != last_sent_i:
                    az, el, rng, _ = bearing_range_el(
                        home_lat, home_lon, home_alt, p["lat"], p["lon"], p["alt"]
                    )
                    az_mag = (az - decl + 360.0) % 360.0
                    pan = ((az_mag - pan_align + 180.0) % 360.0) - 180.0
                    if pan_invert:
                        pan = -pan
                    cmd = f"TRACK TARGET {p['lat']:.8f} {p['lon']:.8f} {p['alt']:g}\n"
                    if self._queue(cmd):
                        sent += 1
                        last_sent_i = i
                    with self._lock:
                        self.state.update(
                            {
                                "index": i + 1,
                                "t": p["t"] - t_flight0,
                                "lat": p["lat"],
                                "lon": p["lon"],
                                "alt": p["alt"],
                                "az": az,
                                "el": el,
                                "range_m": rng,
                                "pan": pan,
                                "message": f"{name} {i + 1}/{len(samples)} t={p['t'] - t_flight0:.2f}s",
                            }
                        )

                if i + 1 >= len(samples):
                    break
                next_due = t_wall0 + (samples[i + 1]["t"] - t_flight0)
                remain = next_due - time.monotonic()
                if remain > 0:
                    time.sleep(min(remain, MAX_INTER_SAMPLE_SLEEP_S))
                i += 1

            with self._lock:
                self.state["active"] = False
                self.state["message"] = (
                    f"done {name}: sent={sent} coalesced={coalesced}"
                    if not self._stop.is_set()
                    else "stopped"
                )
            self._queue("TRACK OFF\n")

        self._thread = threading.Thread(target=run, name="track-sim", daemon=True)
        self._thread.start()
        with self._lock:
            snap = dict(self.state)
        snap["ok"] = True
        snap["points"] = len(samples)
        snap["duration_s"] = duration
        snap["message"] = f"started {name} ({len(samples)} pts, {duration:.1f}s)"
        return snap
