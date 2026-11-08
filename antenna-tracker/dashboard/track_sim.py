"""Replay flight track files as TRACK TARGET lat lon alt on the ESP32.

Dashboard "Start tracking" spawns dashboard/radio_feed.py as a separate process
that paces samples in true wall-clock time (gaps are real silence — no sleep
cap / catch-up). That mirrors radio→host→TRACK TARGET.
"""
from __future__ import annotations

import csv
import json
import math
import re
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

TESTDATA = Path(__file__).resolve().parent / "testdata"
FT_TO_M = 0.3048
RADIO_FEED = Path(__file__).resolve().with_name("radio_feed.py")
OPENSKY_FEED = Path(__file__).resolve().with_name("opensky_feed.py")
_ICAO_RE = re.compile(r"^[0-9a-fA-F]{6}$")


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


def _site_id(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (label or "").strip().lower()).strip("-")
    return (slug[:64] or "site")


def save_site(data: dict) -> dict:
    """Upsert a named site into testdata/sites.json (same catalog as playback homes)."""
    label = str(data.get("label") or "").strip()
    if not label:
        raise ValueError("Site needs a name")
    try:
        lat = float(data["lat"])
        lon = float(data["lon"])
        alt = float(data.get("alt") or 0)
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Site needs numeric lat lon alt") from exc
    sid = str(data.get("id") or "").strip() or _site_id(label)
    notes = str(data.get("notes") or "").strip()
    site = _normalize_site({
        "id": sid,
        "label": label,
        "lat": lat,
        "lon": lon,
        "alt": alt,
        "notes": notes,
        "flights": [],
    })
    if not site:
        raise ValueError("Site lat/lon/alt out of range")

    TESTDATA.mkdir(parents=True, exist_ok=True)
    path = TESTDATA / "sites.json"
    sites: list[dict] = []
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            sites = list(raw.get("sites") or [])
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            sites = []

    stored = {
        "id": site["id"],
        "label": site["label"],
        "lat": site["lat"],
        "lon": site["lon"],
        "alt": site["alt"],
        "notes": site["notes"],
    }
    replaced = False
    for i, item in enumerate(sites):
        if str(item.get("id") or "") == site["id"]:
            prev_flights = list(item.get("flights") or [])
            if prev_flights:
                stored["flights"] = prev_flights
            sites[i] = stored
            replaced = True
            break
    if not replaced:
        sites.append(stored)

    path.write_text(json.dumps({"sites": sites}, indent=2) + "\n", encoding="utf-8")
    # Re-read via list_sites so playback home sidecars stay merged in.
    refreshed = next((s for s in list_sites() if s["id"] == site["id"]), site)
    return {"ok": True, "site": refreshed, "sites": list_sites()}


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
    gap_tag = None
    for tag in ("-gap10s", "_gap10s", "-gap5s", "_gap5s"):
        if stem.endswith(tag):
            gap_tag = tag.lstrip("-_")
            stem = stem[: -len(tag)]
            break
    for junk in (" (1)", "_10hz", "_summary"):
        stem = stem.replace(junk, "")
    if stem.startswith("GPS Data - "):
        stem = stem[len("GPS Data - ") :]
    if stem.startswith("Altimeter Data - "):
        stem = stem[len("Altimeter Data - ") :]
    if gap_tag == "gap10s":
        return f"{stem} · 10s gap before peak accel"
    if gap_tag == "gap5s":
        return f"{stem} · 5s gap before peak accel"
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
        self._proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._stopping = False
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

    def _relay_base(self) -> str:
        port = getattr(self.relay, "http_port", None) or getattr(self.relay, "port", None)
        if port:
            return f"http://127.0.0.1:{int(port)}"
        return "http://127.0.0.1:8765"

    def _apply_status(self, status: dict) -> None:
        keys = (
            "active", "file", "index", "n", "t", "duration_s",
            "lat", "lon", "alt", "az", "el", "range_m", "pan", "message",
            "icao24", "callsign",
        )
        with self._lock:
            for key in keys:
                if key in status:
                    self.state[key] = status[key]

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    status = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(status, dict):
                    self._apply_status(status)
        finally:
            code = proc.wait()
            with self._lock:
                still = self._proc is proc
                if still:
                    self._proc = None
                if still and not self._stopping:
                    self.state["active"] = False
                    if not self.state.get("message") or self.state["message"] == "idle":
                        self.state["message"] = (
                            f"radio-feed exit {code}" if code else "done"
                        )
            if still and not self._stopping:
                try:
                    self.relay.command_track_off()
                except Exception:
                    pass

    def stop_sim(self, send_off: bool = True):
        self._stopping = True
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass
        reader = self._reader
        if reader and reader.is_alive():
            reader.join(timeout=1.5)
        with self._lock:
            self.state["active"] = False
            self.state["message"] = "stopped"
            self._proc = None
            self._reader = None
        self._stopping = False
        if send_off:
            try:
                self.relay.command_track_off()
            except Exception:
                pass

    def _spawn(self, cmd: list[str], cwd: Path, label: str, state: dict) -> dict:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._stopping = False
        self._proc = proc
        with self._lock:
            self.state.update(state)
        self._reader = threading.Thread(
            target=self._read_stdout, args=(proc,), name=f"{label}-stdout", daemon=True
        )
        self._reader.start()
        with self._lock:
            snap = dict(self.state)
        snap["ok"] = True
        snap["message"] = state.get("message") or f"started {label}"
        return snap

    def start(self, body: dict) -> dict:
        home_lat = float(body["lat"])
        home_lon = float(body["lon"])
        home_alt = float(body.get("alt") or 0)
        decl = float(body.get("mag_declination") or 0)
        icao24 = str(body.get("icao24") or "").strip().lower()

        self.stop_sim(send_off=False)

        if icao24:
            if not _ICAO_RE.match(icao24):
                raise ValueError("icao24 must be 6 hex characters (e.g. a1b2c3)")
            if not OPENSKY_FEED.is_file():
                raise FileNotFoundError(f"opensky feed script missing: {OPENSKY_FEED}")
            # point=False → observe-only (poll UI/map, no TRACK TARGET / no HOME).
            point = bool(body.get("point", True))
            if point:
                # HOME + decl; relay also forces Mag PAN feedback (no pot ALIGN).
                self.relay.command_track_home(
                    {
                        "lat": home_lat,
                        "lon": home_lon,
                        "alt": home_alt,
                        "mag_declination": decl,
                    }
                )
            interval = body.get("interval")
            idle_stop = body.get("idle_stop", 600)
            cmd = [
                sys.executable,
                str(OPENSKY_FEED),
                icao24,
                "--relay",
                self._relay_base(),
                "--lat",
                str(home_lat),
                "--lon",
                str(home_lon),
                "--alt",
                str(home_alt),
                "--decl",
                str(decl),
                "--idle-stop",
                str(float(idle_stop) if idle_stop is not None else 600),
            ]
            if not point:
                cmd.append("--observe")
            if interval is not None and str(interval) != "":
                cmd.extend(["--interval", str(float(interval))])
            return self._spawn(
                cmd,
                OPENSKY_FEED.parent,
                "opensky-feed",
                {
                    "active": True,
                    "file": f"opensky:{icao24}",
                    "icao24": icao24,
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
                    "pointing": point,
                    "message": (
                        f"opensky-feed {icao24}"
                        + (" · pointing" if point else " · observe")
                    ),
                },
            )

        # Playback: HOME + decl; relay also forces Mag PAN feedback (no pot ALIGN).
        self.relay.command_track_home(
            {
                "lat": home_lat,
                "lon": home_lon,
                "alt": home_alt,
                "mag_declination": decl,
            }
        )

        name = _safe_name(body.get("file") or "testdata1.csv")
        if not RADIO_FEED.is_file():
            raise FileNotFoundError(f"radio feed script missing: {RADIO_FEED}")
        samples = load_flight(name)
        speed = float(body.get("speed") or 1.0)
        duration = samples[-1]["t"] - samples[0]["t"]
        cmd = [
            sys.executable,
            str(RADIO_FEED),
            name,
            "--relay",
            self._relay_base(),
            "--lat",
            str(home_lat),
            "--lon",
            str(home_lon),
            "--alt",
            str(home_alt),
            "--decl",
            str(decl),
            "--speed",
            str(speed),
        ]
        snap = self._spawn(
            cmd,
            RADIO_FEED.parent,
            "radio-feed",
            {
                "active": True,
                "file": name,
                "index": 0,
                "n": len(samples),
                "t": 0.0,
                "duration_s": duration,
                "lat": None,
                "lon": None,
                "alt": None,
                "az": None,
                "el": None,
                "range_m": None,
                "pan": None,
                "message": f"radio-feed {name} ({len(samples)} pts, {duration:.1f}s realtime)",
            },
        )
        snap["points"] = len(samples)
        snap["duration_s"] = duration
        snap["message"] = (
            f"started radio-feed {name} ({len(samples)} pts, {duration:.1f}s realtime)"
        )
        return snap
