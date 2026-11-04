"""Three +90° PAN position steps with 3 s rests; log pot vs mag."""
import json, math, time, urllib.request

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

def snap():
    v = api('state').get('latest') or {}
    m = (v.get('servo_motion') or {}).get('PAN') or {}
    p = (v.get('servo_position') or {}).get('PAN') or {}
    return {
        'pan': m.get('angle'),
        'spd': m.get('speed'),
        'tgt': p.get('target'),
        'active': p.get('active'),
        'h': heading(v.get('accel'), v.get('mag')),
    }

def wait_settle(target, timeout=8.0):
    t0 = time.monotonic()
    last = None
    while time.monotonic() - t0 < timeout:
        s = snap()
        last = s
        if s['pan'] is not None and abs(wrap(target - s['pan'])) <= 2.0 and abs(s.get('spd') or 0) < 5:
            return s, time.monotonic() - t0
        time.sleep(0.08)
    return last, time.monotonic() - t0

def rest(seconds=3.0):
    rows = []
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        s = snap()
        s['t'] = time.monotonic() - t0
        rows.append(s)
        time.sleep(0.1)
    pans = [r['pan'] for r in rows if r['pan'] is not None]
    hs = [r['h'] for r in rows if r['h'] is not None]
    return {
        'pan_span': max(pans) - min(pans) if pans else None,
        'h_span': max(hs) - min(hs) if hs else None,
        'pan_end': pans[-1] if pans else None,
        'h_end': hs[-1] if hs else None,
    }

s = api('state')
if not (s.get('servo_safety') or {}).get('armed'):
    api('servo-safety', {'action': 'ENABLE'})
    time.sleep(0.4)
api('servo-speed', {'axis': 'PAN', 'speed': 120})
time.sleep(0.2)

results = []
for i in range(1, 4):
    before = snap()
    start = before['pan']
    if start is None:
        raise SystemExit('no pan angle')
    target = (start + 90) % 360
    print(f'--- move {i}/3  pan {start:.2f} -> {target:.2f} (+90 cmd) ---')
    print(f'  before  pan={start:.2f}  h={before["h"] and round(before["h"], 2)}  '
          f'h-pan={before["h"] is not None and round(wrap(before["h"]-start), 2)}')
    api('servo-position', {'axis': 'PAN', 'angle': target})
    after, elapsed = wait_settle(target)
    d_pan = wrap(after['pan'] - start) if after and after['pan'] is not None else None
    d_h = wrap(after['h'] - before['h']) if after and after.get('h') is not None and before.get('h') is not None else None
    print(f'  after   pan={after["pan"]:.2f}  h={after["h"] and round(after["h"], 2)}  '
          f'h-pan={after["h"] is not None and round(wrap(after["h"]-after["pan"]), 2)}  '
          f't={elapsed:.2f}s')
    print(f'  delta   pot={d_pan and round(d_pan, 2)}  mag={d_h and round(d_h, 2)}  '
          f'(pot is self-reported only)')
    results.append(dict(i=i, start=start, target=target, end=after['pan'], d_pan=d_pan, d_h=d_h,
                        h0=before['h'], h1=after['h'], elapsed=elapsed))
    api('servo', {'axis': 'PAN', 'off': True})
    print(f'  rest 3s ...')
    r = rest(3.0)
    print(f'  rest    pan_span={r["pan_span"] and round(r["pan_span"], 3)}  '
          f'h_span={r["h_span"] and round(r["h_span"], 3)}  '
          f'pan={r["pan_end"] and round(r["pan_end"], 2)}  h={r["h_end"] and round(r["h_end"], 2)}')

api('servo', {'axis': 'PAN', 'off': True})
print('=== summary ===')
for r in results:
    print(f'move {r["i"]}: pot Δ {r["d_pan"]:.2f}°  mag Δ {r["d_h"]:.2f}°  '
          f'(ratio mag/pot={r["d_h"]/r["d_pan"]:.3f})' if r['d_pan'] else r)
