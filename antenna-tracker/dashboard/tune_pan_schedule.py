"""Live PAN 10° / 180° step tune against the relay."""
from __future__ import annotations
import json
import math
import time
import urllib.request

BASE = 'http://127.0.0.1:8765'


def api(path, body=None):
    req = urllib.request.Request(BASE + path, method='GET' if body is None else 'POST')
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def wrap_err(a, b):
    return (b - a + 180) % 360 - 180


def sample(n=30, dt=0.15):
    rows = []
    for i in range(n):
        time.sleep(dt)
        s = api('/api/state')['latest']
        m = s['servo_motion']['PAN']
        c = s['servo_pid']['PAN']
        rows.append(dict(
            t=round(i * dt, 2), ang=m['angle'], spd=m['speed'], err=c['error'],
            req=c['request'], phase=c['phase'], out=c['output'],
            active=s['servo_position']['PAN']['active']))
    return rows


def summarize(rows, target):
    reqs = [r['req'] for r in rows if abs(r['req'] or 0) > 1]
    flips = sum(1 for a, b in zip(reqs, reqs[1:]) if math.copysign(1, a) != math.copysign(1, b))
    spds = [r['spd'] for r in rows if abs(r['spd'] or 0) >= 8]
    sflips = sum(1 for a, b in zip(spds, spds[1:]) if math.copysign(1, a) != math.copysign(1, b))
    final = rows[-1]['ang']
    err = abs(wrap_err(final, target))
    settle = None
    for r in rows:
        if abs(wrap_err(r['ang'], target)) < 2.0 and abs(r['spd'] or 0) < 5:
            settle = r['t']
            break
    return dict(
        final=round(final, 2), err=round(err, 2), settle=settle,
        req_flips=flips, spd_flips=sflips,
        phases=sorted({r['phase'] for r in rows}),
        peak_spd=round(max(abs(r['spd'] or 0) for r in rows), 1),
        peak_req=round(max(abs(r['req'] or 0) for r in rows), 1),
        still_active=bool(rows[-1]['active']))


def stop_pan():
    # PID apply stops output; keep current far gains.
    pos = api('/api/state')['latest']['servo_position']['PAN']
    api('/api/servo-pid', dict(
        axis='PAN', kp=pos['kp'], ki=pos['ki'], kd=pos['kd'],
        ilimit=pos['ilimit'], cap=pos['cap'], tolerance=pos['tolerance']))
    time.sleep(0.3)


def step(delta, label, n=40):
    ang = api('/api/state')['latest']['servo_motion']['PAN']['angle']
    tgt = (ang + delta) % 360
    print(f'\n=== {label}: {ang:.2f} -> {tgt:.2f} (d={delta}) ===', flush=True)
    api('/api/servo-position', {'axis': 'PAN', 'angle': tgt})
    rows = sample(n)
    s = summarize(rows, tgt)
    print('summary', s, flush=True)
    show = rows[:5] + rows[-3:]
    for r in show:
        print(
            f"  {r['t']:4.1f} ang={r['ang']:7.2f} spd={r['spd']:7.1f} "
            f"err={r['err']:7.2f} req={r['req']:7.1f} ph={r['phase']} act={r['active']}",
            flush=True)
    return s, tgt


def apply_tune(pid, brk, sch):
    print('pid', api('/api/servo-pid', dict(axis='PAN', **pid)), flush=True)
    print('brk', api('/api/servo-breakaway', dict(axis='PAN', **brk)), flush=True)
    print('sch', api('/api/servo-schedule', dict(axis='PAN', **sch)), flush=True)
    time.sleep(0.4)


def main():
    st = api('/api/state')
    if not (st.get('servo_safety') or {}).get('armed'):
        print('enable', api('/api/servo-safety', {'action': 'ENABLE'}), flush=True)
        time.sleep(1.5)

    # Stop any leftover move from prior script.
    stop_pan()

    # Authority-first schedule: keep deadband nearly full until last few degrees
    # so mid-slew commands stay above the physical ±60/80 µs breakaway.
    pid = dict(kp=3.2, ki=0.03, kd=0, ilimit=50, cap=220, tolerance=1.5)
    brk = dict(offset_us=230, duration_ms=55)
    sch = dict(kp_near=1.4, cap_near=150, schedule_deg=50, brk_min_scale=0.7, settle_deg=5)
    apply_tune(pid, brk, sch)

    results = {}
    for delta, name, n in ((10, '10deg', 35), (180, '180deg', 55), (-10, '10deg back', 35), (-180, '180deg back', 55)):
        s, _ = step(delta, name, n=n)
        results[name] = s
        stop_pan()
        time.sleep(0.4)

    print('\nPASS1', results, flush=True)

    # Nudge from results
    bad10 = any(results[k]['err'] > 2.5 or results[k]['settle'] is None for k in ('10deg', '10deg back'))
    hunt10 = any(results[k]['req_flips'] >= 3 for k in ('10deg', '10deg back'))
    bad180 = any(results[k]['err'] > 3 or results[k]['settle'] is None or (results[k]['settle'] or 0) > 5
                 for k in ('180deg', '180deg back'))
    hunt180 = any(results[k]['req_flips'] >= 4 for k in ('180deg', '180deg back'))

    if hunt10:
        sch['kp_near'] = max(0.8, sch['kp_near'] - 0.3)
        sch['settle_deg'] = min(8, sch['settle_deg'] + 2)
        print('nudge: damp 10', flush=True)
    elif bad10:
        sch['kp_near'] = min(2.2, sch['kp_near'] + 0.3)
        sch['brk_min_scale'] = min(0.9, sch['brk_min_scale'] + 0.1)
        brk['offset_us'] = min(250, brk['offset_us'] + 10)
        brk['duration_ms'] = min(80, brk['duration_ms'] + 10)
        print('nudge: push 10', flush=True)

    if hunt180:
        pid['kp'] = max(2.0, pid['kp'] - 0.4)
        pid['cap'] = max(160, pid['cap'] - 30)
        print('nudge: damp 180', flush=True)
    elif bad180:
        pid['kp'] = min(4.0, pid['kp'] + 0.3)
        brk['duration_ms'] = min(90, brk['duration_ms'] + 15)
        print('nudge: push 180', flush=True)

    apply_tune(pid, brk, sch)
    results2 = {}
    for delta, name, n in ((10, '10deg', 35), (180, '180deg', 55)):
        s, _ = step(delta, 'R2 ' + name, n=n)
        results2[name] = s
        stop_pan()
        time.sleep(0.4)

    print('\nPASS2', results2, flush=True)
    print('save', api('/api/pan', {'action': 'save'}), flush=True)
    time.sleep(0.5)
    c = api('/api/state')['latest']['effective_config']
    p = api('/api/state')['latest']['servo_position']['PAN']
    print('SAVED cfg', {k: c.get(k) for k in (
        'pan_kp', 'pan_ki', 'pan_breakaway_us', 'pan_breakaway_ms',
        'pan_kp_near', 'pan_cap_near', 'pan_schedule_deg',
        'pan_brk_min_scale', 'pan_settle_deg')}, flush=True)
    print('SAVED pos', {k: p.get(k) for k in ('kp', 'ki', 'cap', 'tolerance')}, flush=True)


if __name__ == '__main__':
    main()
