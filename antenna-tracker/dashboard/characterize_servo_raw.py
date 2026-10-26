"""Hold actual integer PWM commands with speed regulation bypassed."""
import json
import time
import urllib.request
from pathlib import Path

def api(path, data=None):
    path = 'state?since=2147483647' if path == 'state' else path
    request = urllib.request.Request('http://192.168.20.2:8765/api/'+path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)

rows = []
original = None
try:
    state = api('state'); latest = state['latest']
    if state['status'] != 'connected' or time.time()-(latest.get('sensor_received_at') or 0)>4:
        raise RuntimeError('Fresh telemetry required')
    original = (state['servo_safety']['armed'], latest['servo_motion']['TILT']['limit'])
    if not original[0]:
        api('servo-safety', {'action': 'ENABLE'}); time.sleep(.5)
    for pulse in (1541, 1542, 1543):
        api('servo', dict(axis='TILT', pulse=pulse, frequency=50, continuous=True, speed_limit=0))
        begin = time.monotonic(); stamp = None; excessive = 0
        part = []
        while time.monotonic()-begin < 30:
            state = api('state'); latest = state['latest']
            if state['status'] != 'connected' or time.time()-(latest.get('sensor_received_at') or 0)>4:
                raise RuntimeError('Telemetry stale')
            new_stamp = latest.get('sensor_device_ms')
            if stamp != new_stamp:
                stamp = new_stamp
                motion = latest['servo_motion']['TILT']; output = latest['servos']['TILT']
                row = dict(command=pulse, sec=time.monotonic()-begin, stamp=stamp,
                    volts=latest['tilt_config']['filtered'], raw_volts=latest['tilt_config']['volts'],
                    speed=motion['speed'], pulse=output['pulse'], enabled=output['enable'])
                rows.append(row); part.append(row)
                excessive = excessive+1 if abs(row['speed'] or 0)>300 else 0
                if excessive>=6 or (row['sec']>1 and not row['enabled']):
                    print('Bound or output stopped:', row, flush=True); break
            time.sleep(.025)
        if part:
            print(json.dumps(dict(command=pulse, seconds=part[-1]['sec'],
                start_volts=part[0]['volts'], end_volts=part[-1]['volts'],
                peak_speed=max(abs(r['speed'] or 0) for r in part),
                stationary_fraction=sum(abs(r['speed'] or 0)<1 for r in part)/len(part))), flush=True)
        api('servo', dict(axis='TILT', pulse=1500, frequency=50, continuous=True, speed_limit=0)); time.sleep(2)
finally:
    if original:
        try:
            api('servo', dict(axis='TILT', pulse=1500, frequency=50, continuous=True, speed_limit=0)); time.sleep(.5)
            api('servo', dict(axis='TILT', off=True)); time.sleep(.3)
            api('servo-speed', dict(axis='TILT', speed=original[1])); time.sleep(.3)
            if not original[0]: api('servo-safety', {'action': 'DISABLE'})
        except Exception as error:
            print('Verify stop:', error, flush=True)
    filename = Path('dashboard')/time.strftime('servo-raw-characterization-%Y%m%d-%H%M%S.json')
    filename.write_text(json.dumps(rows, indent=2))
    print('Saved', filename, len(rows), 'samples', flush=True)
