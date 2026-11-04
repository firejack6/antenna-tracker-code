"""Compare PAN pot angle vs mag heading at rest and during a powered slew."""
import json, math, statistics, time, urllib.request

BASE = 'http://127.0.0.1:8765'

def api(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        BASE + '/api/' + ('state?since=2147483647' if path == 'state' else path),
        data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)

def wrap(d):
    return (d + 180) % 360 - 180

def heading(accel, mag):
    if not accel or not mag or math.hypot(*accel) < 0.1:
        return None
    ax, ay, az = accel
    roll = math.atan2(ay, az)
    pitch = math.atan2(-ax, math.hypot(ay, az))
    mx, my, mz = mag
    hx = mx * math.cos(pitch) + mz * math.sin(pitch)
    hy = (mx * math.sin(roll) * math.sin(pitch) + my * math.cos(roll)
          - mz * math.sin(roll) * math.cos(pitch))
    if math.hypot(hx, hy) < 1e-6:
        return None
    return (math.degrees(math.atan2(-hy, hx)) + 360) % 360

def sample():
    v = api('state').get('latest') or {}
    m = (v.get('servo_motion') or {}).get('PAN') or {}
    pc = v.get('pan_config') or {}
    return {
        'pan': m.get('angle'),
        'spd': m.get('speed'),
        'volts': pc.get('volts'),
        'h': heading(v.get('accel'), v.get('mag')),
        'mag': v.get('mag'),
        'accel': v.get('accel'),
    }

def collect(seconds, dt=0.05):
    rows = []
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        r = sample()
        r['t'] = time.monotonic() - t0
        if r['pan'] is not None and r['h'] is not None:
            r['h_minus_pan'] = wrap(r['h'] - r['pan'])
        rows.append(r)
        time.sleep(dt)
    return rows

print('=== REST 3s (motor off) ===')
api('servo', {'axis': 'PAN', 'off': True})
time.sleep(0.4)
rest = collect(3)
pans = [r['pan'] for r in rest if r['pan'] is not None]
hs = [r['h'] for r in rest if r['h'] is not None]
volts = [r['volts'] for r in rest if r['volts'] is not None]
print(f'pan  n={len(pans)} span={max(pans)-min(pans):.4f} std={statistics.pstdev(pans):.4f}')
print(f'hdg  n={len(hs)} span={max(hs)-min(hs):.4f} std={statistics.pstdev(hs):.4f}')
if volts:
    print(f'volt n={len(volts)} span={max(volts)-min(volts):.5f} std={statistics.pstdev(volts):.5f}')

print('=== POWERED +45 deg ===')
s = api('state')
if not (s.get('servo_safety') or {}).get('armed'):
    api('servo-safety', {'action': 'ENABLE'})
    time.sleep(0.3)
start = sample()['pan']
tgt = (start + 45) % 360
api('servo-speed', {'axis': 'PAN', 'speed': 80})
api('servo-position', {'axis': 'PAN', 'angle': tgt})
rows = collect(5, 0.08)
api('servo', {'axis': 'PAN', 'off': True})
time.sleep(0.5)
post = collect(2)

valid = [r for r in rows if r.get('pan') is not None and r.get('h') is not None]
print(f'during pan {valid[0]["pan"]:.2f}->{valid[-1]["pan"]:.2f} d={wrap(valid[-1]["pan"]-valid[0]["pan"]):.2f}')
print(f'during hdg {valid[0]["h"]:.2f}->{valid[-1]["h"]:.2f} d={wrap(valid[-1]["h"]-valid[0]["h"]):.2f}')
print(f'during h-pan {valid[0]["h_minus_pan"]:.2f}->{valid[-1]["h_minus_pan"]:.2f}')
for r in valid[::5]:
    print(f'  t={r["t"]:4.2f} pan={r["pan"]:7.2f} h={r["h"]:7.2f} '
          f'h-pan={r["h_minus_pan"]:6.1f} spd={r["spd"]}')

pp = [r['pan'] for r in post if r['pan'] is not None]
hh = [r['h'] for r in post if r['h'] is not None]
print(f'=== POST rest 2s === pan span={max(pp)-min(pp):.4f} hdg span={max(hh)-min(hh):.4f}')
print(f'final pan={pp[-1]:.2f} h={hh[-1]:.2f} h-pan={wrap(hh[-1]-pp[-1]):.2f}')
print(f'start={start:.2f} commanded={tgt:.2f}')
