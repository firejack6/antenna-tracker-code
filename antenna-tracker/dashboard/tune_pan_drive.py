"""Drive a few PAN ±90° trials and nudge breakaway/Kp. Watch-only for the user."""
import json, time, urllib.request

BASE = 'http://127.0.0.1:8765'


def api(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        f'{BASE}/api/{path}', data=body,
        headers={'Content-Type': 'application/json'} if body else {},
        method='POST' if body else 'GET',
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def state():
    with urllib.request.urlopen(f'{BASE}/api/state?since=2147483647', timeout=5) as r:
        return json.loads(r.read().decode())


def wrap180(d):
    return (d + 180) % 360 - 180


def pointing_err(s):
    latest = s.get('latest') or {}
    pos = (latest.get('servo_position') or {}).get('PAN') or {}
    motion = (latest.get('servo_motion') or {}).get('PAN') or {}
    pid = (latest.get('servo_pid') or {}).get('PAN') or {}
    tgt = pos.get('target') if pos.get('active') else None
    if tgt is None and pid.get('mode') == 1:
        tgt = pid.get('setpoint')
    ang = motion.get('angle')
    if tgt is None or ang is None:
        return None, bool(pos.get('active')), pid
    return wrap180(tgt - ang), bool(pos.get('active')), pid


def cfg(s):
    c = (s.get('latest') or {}).get('effective_config') or {}
    return {
        'brk': c.get('pan_breakaway_us'), 'brk_ms': c.get('pan_breakaway_ms'),
        'kp': c.get('pan_kp'), 'kp_near': c.get('pan_kp_near'),
        'schedule': c.get('pan_schedule_deg'), 'fb': c.get('pan_fb'),
    }


def apply_tune(brk, brk_ms, kp, kp_near, schedule=55, cap=180, cap_near=120):
    api('servo-breakaway', {'axis': 'PAN', 'offset_us': brk, 'duration_ms': brk_ms})
    time.sleep(0.25)
    api('servo-pid', {'axis': 'PAN', 'kp': kp, 'ki': 0, 'kd': 0, 'ilimit': 40, 'cap': cap, 'tolerance': 2})
    time.sleep(0.25)
    api('servo-schedule', {
        'axis': 'PAN', 'kp_near': kp_near, 'ki_near': 0.4, 'kd_near': 0,
        'cap_near': cap_near,
        'schedule_deg': schedule, 'brk_min_scale': 0.5, 'settle_deg': 14,
    })
    time.sleep(0.7)


def off():
    try:
        api('servo', {'axis': 'PAN', 'off': True})
    except Exception as e:
        print('OFF failed', e)


def heading(s):
    return ((s.get('latest') or {}).get('servo_motion') or {}).get('PAN', {}).get('angle')


def run_step(delta, settle_s=5.5):
    s0 = state()
    h0 = heading(s0)
    if h0 is None:
        raise RuntimeError('no heading/angle')
    tgt = (h0 + delta) % 360
    api('servo-position', {'axis': 'PAN', 'angle': tgt})
    t0 = time.time()
    series = []
    crossed = False
    reverse = False
    last_sign = None
    peak_abs = 0.0
    min_abs_after_1s = None
    while time.time() - t0 < settle_s:
        time.sleep(0.12)
        err, active, pid = pointing_err(state())
        if err is None:
            continue
        ae = abs(err)
        peak_abs = max(peak_abs, ae)
        if time.time() - t0 >= 1.0:
            min_abs_after_1s = ae if min_abs_after_1s is None else min(min_abs_after_1s, ae)
        sign = 1 if err > 0.8 else -1 if err < -0.8 else 0
        if last_sign is None and sign != 0:
            last_sign = sign
        elif sign != 0 and last_sign is not None and sign != last_sign:
            if ae < peak_abs * 0.85:
                reverse = True
            last_sign = sign
        if ae < 7:
            crossed = True
        series.append((time.time() - t0, err, active, pid.get('request')))
    off()
    time.sleep(0.5)
    final = series[-1][1] if series else None
    overshoot = False
    if series:
        e0 = series[0][1]
        for _, e, *_ in series:
            if e0 * e < 0 and abs(e) > 3:
                overshoot = True
                break
    return {
        'delta': delta,
        'final_err': final,
        'peak_abs': peak_abs,
        'best_after_1s': min_abs_after_1s,
        'overshoot': overshoot,
        'reverse': reverse,
        'crossed_7': crossed,
        'n': len(series),
    }


def main():
    st = state()
    print('status', st.get('status'), 'cfg', cfg(st))
    if not (st.get('servo_safety') or {}).get('armed'):
        raise SystemExit('servos not armed — enable first')

    brk, brk_ms, kp, kp_near = 140, 45, 0.12, 0.04
    apply_tune(brk, brk_ms, kp, kp_near)
    print('baseline', cfg(state()))

    results = []
    for trial in range(1, 7):
        print(f'\n=== trial {trial} brk={brk}/{brk_ms} kp={kp:.3f} kp_near={kp_near:.3f} ===')
        delta = 90 if trial % 2 else -90
        r = run_step(delta, settle_s=5.5)
        results.append((dict(brk=brk, brk_ms=brk_ms, kp=kp, kp_near=kp_near), r))
        printable = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items() if k != 'n'}
        print('result', printable)

        if r['reverse'] or r['overshoot']:
            brk = max(90, brk - 20)
            brk_ms = max(25, brk_ms - 8)
            kp = max(0.04, kp * 0.75)
            kp_near = max(0.015, kp_near * 0.75)
            reason = 'overshoot/reverse -> cooler'
        elif not r['crossed_7'] or (r['best_after_1s'] is not None and r['best_after_1s'] > 15):
            brk = min(200, brk + 15)
            brk_ms = min(80, brk_ms + 8)
            kp = min(0.35, kp * 1.2 + 0.01)
            kp_near = min(0.12, max(0.02, kp * 0.3))
            reason = 'slow/stall -> hotter'
        elif abs(r['final_err'] or 99) > 7:
            kp = min(0.3, kp + 0.02)
            kp_near = min(0.1, kp_near + 0.01)
            reason = 'residual error -> slightly hotter Kp'
        else:
            print('good enough — hold')
            apply_tune(brk, brk_ms, kp, kp_near)
            break

        print(reason, f'-> brk={brk}/{brk_ms} kp={kp:.3f} kp_near={kp_near:.3f}')
        apply_tune(brk, brk_ms, kp, kp_near)
        time.sleep(0.8)

    off()
    print('\n=== FINAL', cfg(state()), '===')
    for params, r in results:
        printable = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items() if k != 'n'}
        print(params, '=>', printable)


if __name__ == '__main__':
    main()
