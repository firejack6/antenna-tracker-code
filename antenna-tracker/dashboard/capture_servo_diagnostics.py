"""Read-only capture of feedback, gyro, supply channels and PWM from shared relay."""
import json, time, urllib.request
from pathlib import Path
rows = []
end = time.monotonic() + 25
last_stamp = None
while time.monotonic() < end:
    with urllib.request.urlopen('http://192.168.20.2:8765/api/state?since=2147483647', timeout=2) as response:
        state = json.load(response)
    latest = state.get('latest') or {}
    stamp = latest.get('sensor_device_ms')
    if stamp != last_stamp:
        rows.append(latest); last_stamp = stamp
    time.sleep(.025)
Path('dashboard/servo-tuning-diagnostics.json').write_text(json.dumps(rows, indent=2))
print('Captured', len(rows), 'complete telemetry samples')
