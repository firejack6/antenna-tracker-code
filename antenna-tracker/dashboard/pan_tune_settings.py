"""Persist last PAN Tune GUI settings (gitignored JSON)."""
from __future__ import annotations

import json
import time
from pathlib import Path

SETTINGS_PATH = Path(__file__).resolve().parent / "pan_tune_settings.json"

# Keys the Tune page owns. Keep in sync with pan-tune.js collectSettings().
NUMERIC_KEYS = (
    "kp", "ki", "kd", "ilimit", "cap", "tolerance",
    "kp_near", "ki_near", "kd_near", "cap_near", "schedule_deg", "brk_min_scale", "settle_deg",
    "offset_us", "duration_ms", "dbplus", "dbminus",
    "ramp_rate", "speed",
)
STRING_KEYS = ("pan_fb",)
BOOL_KEYS = ("ramp_enabled",)


def _clean(raw: dict) -> dict:
    out: dict = {}
    for key in NUMERIC_KEYS:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value == value:  # not NaN
            out[key] = float(value)
    for key in STRING_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.upper() in ("MAG", "POT"):
            out[key] = value.upper()
    for key in BOOL_KEYS:
        if key in raw:
            out[key] = bool(raw[key])
    return out


def load_settings() -> dict | None:
    if not SETTINGS_PATH.is_file():
        return None
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(raw, dict):
        return None
    settings = raw.get("settings") if isinstance(raw.get("settings"), dict) else raw
    cleaned = _clean(settings if isinstance(settings, dict) else {})
    return cleaned or None


def public_status() -> dict:
    settings = load_settings()
    saved_at = None
    if SETTINGS_PATH.is_file():
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("saved_at"), (int, float)):
                saved_at = raw["saved_at"]
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    return {
        "ok": True,
        "path": str(SETTINGS_PATH),
        "exists": settings is not None,
        "saved_at": saved_at,
        "settings": settings,
    }


def save_settings(settings: dict) -> dict:
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    cleaned = _clean(settings)
    if not cleaned:
        raise ValueError("No valid PAN tune settings to save")
    payload = {
        "saved_at": time.time(),
        "settings": cleaned,
    }
    SETTINGS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "path": str(SETTINGS_PATH),
        "saved_at": payload["saved_at"],
        "settings": cleaned,
    }
