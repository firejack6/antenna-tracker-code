"""Local OpenSky OAuth client credentials (gitignored JSON + optional .env)."""
from __future__ import annotations

import json
import os
from pathlib import Path

CREDS_PATH = Path(__file__).resolve().parent / "opensky_credentials.json"
ROOT_ENV = Path(__file__).resolve().parent.parent / ".env"
DASH_ENV = Path(__file__).resolve().parent / ".env"
DEFAULT_CLIENT_ID = "your-opensky-client-id"


def _load_dotenv_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def _env_overrides() -> dict[str, str]:
    # Process env wins, then antenna-tracker/.env, then dashboard/.env.
    merged = {}
    merged.update(_load_dotenv_file(DASH_ENV))
    merged.update(_load_dotenv_file(ROOT_ENV))
    for key in ("OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET"):
        if os.environ.get(key):
            merged[key] = os.environ[key]
    return merged


def load_credentials() -> dict:
    data = {"client_id": DEFAULT_CLIENT_ID, "client_secret": ""}
    if CREDS_PATH.is_file():
        try:
            raw = json.loads(CREDS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            raw = {}
        if isinstance(raw, dict):
            # Accept snake_case (ours) or camelCase (OpenSky console / pasted JSON).
            cid = raw.get("client_id") if isinstance(raw.get("client_id"), str) else None
            if cid is None and isinstance(raw.get("clientId"), str):
                cid = raw["clientId"]
            if cid and cid.strip():
                data["client_id"] = cid.strip()
            secret = raw.get("client_secret") if isinstance(raw.get("client_secret"), str) else None
            if secret is None and isinstance(raw.get("clientSecret"), str):
                secret = raw["clientSecret"]
            if secret is not None:
                data["client_secret"] = secret
    env = _env_overrides()
    if env.get("OPENSKY_CLIENT_ID", "").strip():
        data["client_id"] = env["OPENSKY_CLIENT_ID"].strip()
    if "OPENSKY_CLIENT_SECRET" in env and env.get("OPENSKY_CLIENT_SECRET") is not None:
        # Allow .env to supply secret when JSON is empty; non-empty JSON still loses to env.
        if env["OPENSKY_CLIENT_SECRET"] != "" or not data.get("client_secret"):
            data["client_secret"] = env.get("OPENSKY_CLIENT_SECRET") or ""
    return data


def save_credentials(client_id: str, client_secret: str | None = None) -> dict:
    """Write credentials. If client_secret is None, keep existing secret."""
    current = load_credentials()
    cid = (client_id or "").strip() or DEFAULT_CLIENT_ID
    if client_secret is None:
        secret = current.get("client_secret") or ""
    else:
        secret = client_secret
    payload = {"client_id": cid, "client_secret": secret}
    CREDS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "client_id": cid,
        "has_secret": bool(secret),
        "path": str(CREDS_PATH),
    }


def public_status() -> dict:
    c = load_credentials()
    return {
        "client_id": c.get("client_id") or DEFAULT_CLIENT_ID,
        "has_secret": bool(c.get("client_secret")),
        "path": str(CREDS_PATH),
        "authenticated": bool(c.get("client_id") and c.get("client_secret")),
    }
