"""Measure live acquisition without issuing servo commands."""
import argparse
import json
import time
from relay import Relay

args = argparse.ArgumentParser()
args.add_argument('--agent', default='desktop-o1gdd79')
args.add_argument('--port', default='COM8')
args.add_argument('--seconds', type=float, default=15)
args.add_argument('--record', action='store_true', help='Also verify full-rate CSV recording')
args.add_argument('--check-control', action='store_true', help='Verify TILT OFF command and board acknowledgement')
options = args.parse_args()
relay = Relay()
try:
    relay.connect(dict(mode='remote', agent=options.agent, port=options.port, baud=115200))
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        snapshot = relay.snapshot()
        if snapshot['status'] == 'error': raise RuntimeError(snapshot['message'])
        if snapshot['latest'] and snapshot['latest'].get('rates'):
            break
        time.sleep(.1)
    else: raise RuntimeError('Timed out waiting for acquisition stats: ' + str(snapshot['latest']) + str(snapshot['logs'][-20:]))
    # Exclude initial ring/USB backlog from the steady-rate measurement.
    time.sleep(2)
    if options.check_control:
        relay.command_servo(dict(axis='TILT', off=True))
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline:
            status = relay.snapshot().get('servo_commands', {}).get('TILT', {})
            if status.get('state') == 'applied': break
            if status.get('state') in ('error', 'timeout'): raise RuntimeError(str(status))
            time.sleep(.05)
        else: raise RuntimeError('No acknowledgement for TILT OFF: ' + str(status))
    first = relay.snapshot()
    if options.record:
        relay.recorder.start([dict(m=1, b=0) for _ in range(16)])
    first_stamp, first_scans = first['latest'].get('device_us'), first['acquisition']['raw_scans']
    started = time.monotonic()
    deadline = started + options.seconds
    while time.monotonic() < deadline:
        time.sleep(.2)
        if relay.snapshot()['status'] == 'error': raise RuntimeError(relay.snapshot()['message'])
    last = relay.snapshot()
    elapsed = time.monotonic() - started
    latest = last['latest']
    result = dict(duration_s=round(elapsed, 3), firmware_rates=latest.get('rates'),
                  received_scans_per_s=round((last['acquisition']['raw_scans'] - first_scans) / elapsed, 1),
                  acquisition=last['acquisition'], ranges=latest.get('ranges'),
                  servo_enabled={axis: values['enable'] for axis, values in latest.get('servos', {}).items()},
                  errors=latest.get('errors'), last_logs=[line['text'] for line in last['logs'][-8:]])
    result['gap_delta'] = last['acquisition']['sequence_gaps'] - first['acquisition']['sequence_gaps']
    result['firmware_drop_delta'] = latest.get('rates', {}).get('drops', 0) - first['latest'].get('rates', {}).get('drops', 0)
    result['firmware_missed_delta'] = latest.get('rates', {}).get('missed', 0) - first['latest'].get('rates', {}).get('missed', 0)
    if options.check_control: result['control'] = last['servo_commands']['TILT']
    if options.record: result['recording'] = relay.recorder.stop()
    if first_stamp is not None and latest.get('device_us'):
        result['received_scans_per_device_s'] = round((last['acquisition']['raw_scans'] - first_scans) * 1e6 / (latest['device_us'] - first_stamp), 1)
    print(json.dumps(result, indent=2))
except Exception:
    snapshot = relay.snapshot()
    print(json.dumps(dict(status=snapshot['status'], message=snapshot['message'],
                         acquisition=snapshot['acquisition'], latest=snapshot['latest'],
                         logs=[line['text'] for line in snapshot['logs'][-30:]]), indent=2))
    raise
finally:
    relay.disconnect()
    relay.recorder.stop()
