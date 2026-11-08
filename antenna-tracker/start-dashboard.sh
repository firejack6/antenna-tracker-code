#!/usr/bin/env bash
# Start the antenna-tracker dashboard relay on Linux.
# Usage:
#   ./start-dashboard.sh
#   ./start-dashboard.sh --port 8766 --no-browser
#   ./start-dashboard.sh --host 0.0.0.0 --no-browser
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD="$ROOT/dashboard"
VENV="$DASHBOARD/venv"
PORT=8765
HOST=127.0.0.1
NO_BROWSER=0
SKIP_WIFI=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?}"; shift 2 ;;
    --host) HOST="${2:?}"; shift 2 ;;
    --no-browser) NO_BROWSER=1; shift ;;
    --skip-wifi) SKIP_WIFI=1; shift ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

url="http://${HOST}:${PORT}"

# Reuse an already-running relay on this port when possible.
if curl -fsS --max-time 2 "${url}/api/state?since=2147483647" >/dev/null 2>&1; then
  echo "Dashboard already running: ${url}"
  if [[ "$NO_BROWSER" -eq 0 ]] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
  exit 0
fi

# Optional: join ESP AP from src/network_config.h (NetworkManager).
if [[ "$SKIP_WIFI" -eq 0 && -f "$ROOT/src/network_config.h" ]] && command -v nmcli >/dev/null 2>&1; then
  if grep -Eq 'WIFI_ACCESS_POINT[[:space:]]*=[[:space:]]*true' "$ROOT/src/network_config.h"; then
    ssid="$(sed -n 's/.*WIFI_SSID\[\][[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/src/network_config.h" | head -n1)"
    pass="$(sed -n 's/.*WIFI_PASSWORD\[\][[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/src/network_config.h" | head -n1)"
    if [[ -n "$ssid" ]]; then
      echo "Connecting Wi-Fi to ${ssid} via nmcli..."
      if nmcli device wifi connect "$ssid" ${pass:+password "$pass"} >/dev/null 2>&1; then
        echo "Wi-Fi connected: ${ssid}"
      else
        echo "Wi-Fi connect failed (join hotspot manually); continuing." >&2
      fi
    fi
  fi
fi

PYTHON=""
if [[ -x "$VENV/bin/python" ]]; then
  PYTHON="$VENV/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="$(command -v python3)"
else
  echo "python3 not found" >&2
  exit 1
fi

# Prefer a dashboard venv; create + install requirements on first run.
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating dashboard venv at ${VENV}..."
  "$PYTHON" -m venv "$VENV"
  PYTHON="$VENV/bin/python"
  "$PYTHON" -m pip install --upgrade pip
  "$PYTHON" -m pip install -r "$DASHBOARD/requirements.txt"
elif [[ -f "$DASHBOARD/requirements.txt" ]]; then
  # Keep pyserial available without forcing a full reinstall every launch.
  if ! "$PYTHON" -c 'import serial' >/dev/null 2>&1; then
    echo "Installing dashboard/requirements.txt into venv..."
    "$PYTHON" -m pip install -r "$DASHBOARD/requirements.txt"
  fi
fi

args=("$DASHBOARD/relay.py" --host "$HOST" --port "$PORT")
if [[ "$NO_BROWSER" -eq 1 ]]; then
  args+=(--no-browser)
fi

cd "$ROOT"
exec "$PYTHON" "${args[@]}"
