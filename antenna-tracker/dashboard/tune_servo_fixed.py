"""Fixed-output TILT characterization through the shared dashboard."""
import json, time, urllib.request
from pathlib import Path

def api(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    path = 'state?since=2147483647' if path == 'state' else path
    req = urllib.request.Request('http://192.168.20.2:8765/api/' + path, data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.load(response)

rows = []
original = None
try:
    s = api('state'); v = s['latest']
    if s['status'] != 'connected' or time.time() - v['sensor_received_at'] > .75:
        raise RuntimeError('Fresh telemetry required')
    original = (s['servo_safety']['armed'], v['servo_motion']['TILT']['limit'], bool(v['servo_motion']['TILT']['osfault']))
    if not original[0]:
        api('servo-safety', {'action': 'ENABLE'}); time.sleep(.5)
    api('servo-overspeed', dict(axis='TILT', enabled=False)); time.sleep(.3)
    for pulse in (1541.25, 1541.5625, 1541.875, 1542.1875):
        # Equal cap/minimum holds a fractional pulse until feedback asks to brake.
        api('tilt', dict(action='sweep_start', speed=1, direction=1, polarity=1,
                         cap=pulse-1500, minimum=pulse-1500, rotations=1))
        begin = time.monotonic(); last_stamp = None; start = None
        while time.monotonic() - begin < 12:
            s = api('state'); v = s['latest']; t = v['tilt_config']; m = v['servo_motion']['TILT']
            if s['status'] != 'connected' or time.time() - v['sensor_received_at'] > .75:
                raise RuntimeError('Stale telemetry')
            if v['sensor_device_ms'] != last_stamp:
                last_stamp = v['sensor_device_ms']; volts = t['filtered']
                start = volts if start is None else start
                row = dict(command=pulse, sec=time.monotonic()-begin, volts=volts,
                           raw=t['volts'], speed=m['speed'], pulse=v['servos']['TILT']['pulse'],
                           output=v.get('servo_pid', {}).get('TILT', {}).get('output'))
                rows.append(row)
                if abs(volts-start)*360/3.296 > 100 or abs(m['speed'] or 0) > 500:
                    print('Motion bound', row, flush=True); break
                if time.monotonic()-begin > 1 and t['sweep'] != 1:
                    break
            time.sleep(.025)
        part = [r for r in rows if r['command'] == pulse]
        print(pulse, 'duration', round(part[-1]['sec'], 2), 'net deg',
              round((part[-1]['volts']-part[0]['volts'])*360/3.296, 2),
              'peak speed', round(max(abs(r['speed'] or 0) for r in part), 2), flush=True)
        api('tilt', dict(action='sweep_stop')); time.sleep(.2)
        api('servo', dict(axis='TILT', pulse=1500, frequency=50, continuous=True, speed_limit=0))
        time.sleep(1)
finally:
    if original:
        try:
            api('tilt', dict(action='sweep_stop')); time.sleep(.2)
            api('servo', dict(axis='TILT', pulse=1500, frequency=50, continuous=True, speed_limit=0)); time.sleep(.5)
            api('servo', dict(axis='TILT', off=True)); time.sleep(.3)
            api('servo-speed', dict(axis='TILT', speed=original[1])); time.sleep(.3)
            api('servo-overspeed', dict(axis='TILT', enabled=original[2])); time.sleep(.3)
            if not original[0]: api('servo-safety', dict(action='DISABLE'))
        except Exception as exc: print('Verify stop:', exc, flush=True)
    Path('dashboard/servo-tuning-fractional.json').write_text(json.dumps(rows, indent=2))
