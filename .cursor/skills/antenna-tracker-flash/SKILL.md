---
name: antenna-tracker-flash
description: >-
  Flash antenna-tracker Nano ESP32 firmware and restart the dashboard relay via
  PlatformIO Remote. Use when the user asks to upload, flash, DFU, deploy
  firmware, pio upload, restart the relay/python script, or after firmware
  changes that need a board update.
---

# Antenna-tracker flash + relay

## Hard rule

Firmware lives on the **remote agent** (`desktop-o1gdd79`). This PC has no board.

| Do | Don't |
|----|--------|
| `pio remote --agent desktop-o1gdd79 … -t upload` | `pio run -t upload` |
| Upload from `antenna-tracker/` | Local DFU / esptool on this machine |

## Upload

```bash
cd antenna-tracker
pio remote --agent desktop-o1gdd79 run --force-remote -e arduino_nano_esp32 -t upload
```

1. If `Could not find active agents`: run `pio remote agent list`. Ask user to start the agent on the remote PC (`pio remote agent start`), then retry. **Do not** try local upload.
2. Success looks like remote DFU `Device ID 2341:0070` and `[SUCCESS]`.
3. Unless the user asks to move axes, send **no** servo/position/PWM commands after flash.

## Restart relay

Kill any existing `dashboard/relay.py`, then:

```bash
python dashboard/relay.py --no-browser
```

from `antenna-tracker/`. Dashboard: `http://127.0.0.1:8765`. Connect over Wi‑Fi TCP (`192.168.20.1:9000`) as usual — do not assume remote serial for day-to-day telemetry.
