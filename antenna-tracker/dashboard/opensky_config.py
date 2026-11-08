"""Local OpenSky OAuth client credentials (gitignored JSON)."""
from __future__ import annotations

import json
from pathlib import Path

CREDS_PATH = Path(__file__).resolve().parent / "opensky_credentials.json"
DEFAULT_CLIENT_ID = "your-opensky-client-id"


def load_credentials() -> dict:
    data = {"client_id": DEFAULT_CLIENT_ID, "client_secret": ""}
    if not CREDS_PATH.is_file():
        return data
    try:
        raw = json.loads(CREDS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return data
    if not isinstance(raw, dict):
        return data
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
