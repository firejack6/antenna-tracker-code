"""PAN continuous-rotation characterization (pot feedback vs PWM).

PAN is CR: pulses above/below neutral command speed, not absolute angle.
Default: one direction from neutral toward +offsets (or --direction -1).

Phases:
  1. stationary — noise at neutral with output off / then at neutral hold
  2. steps     — ESP PWM slew to each offset, cruise hold, slew back
  3. sweep     — optional slow SERVO PWM SWEEP neutral → end (one way)

Writes JSON + prints speed-vs-offset summary.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', default='http://127.0.0.1:8765')
parser.add_argument('--direction', type=int, choices=(-1, 1), default=1,
                    help='+1: pulses above neutral; -1: below')
parser.add_argument('--max-offset', type=int, default=100,
                    help='Max |pulse - neutral| µs (default matches UI preset band)')
parser.add_argument('--step', type=int, default=20, help='Offset step µs')
parser.add_argument('--hold', type=float, default=3.0, help='Seconds at each offset')
parser.add_argument('--stationary', type=float, default=3.0)
parser.add_argument('--rate', type=float, default=20.0, help='Final one-way PWM sweep rate µs/s')
parser.add_argument('--accel-rate', type=float, default=40.0,
                    help='Max PWM slew (µs/s); applied on ESP via SERVO PWM SLEW')
parser.add_argument('--accel', type=float, default=80.0,
                    help='PWM slew accel (µs/s²); applied on ESP')
parser.add_argument('--host-slew', action='store_true',
                    help='Fallback: microstep PWM from the host instead of ESP slew')
parser.add_argument('--skip-sweep', action='store_true')
parser.add_argument('--skip-steps', action='store_true')
parser.add_argument('--no-enable', action='store_true')
args = parser.parse_args()

# Last commanded PAN pulse (µs); used so host ramps start from the true hold.
_current_pulse = [None]


def api(path, data=None, timeout=3):
    path = 'state?since=2147483647' if path == 'state' else path
    request = urllib.request.Request(
        args.base.rstrip('/') + '/api/' + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def wait_connected(deadline=45):
    end = time.monotonic() + deadline
    last = None
    attempted = False
    while time.monotonic() < end:
        try:
            state = api('state')
            last = state
            latest = state.get('latest') or {}
            age = time.time() - latest.get('received_at', 0)
            if state.get('status') == 'connected' and age < 2 and (latest.get('servos') or {}).get('PAN'):
                return state
            if not attempted and state.get('status') != 'connected':
                attempted = True
                try:
                    api('disconnect', {})
                except Exception:
                    pass
                time.sleep(0.3)
                try:
                    api('connect', {'mode': 'tcp', 'port': '192.168.20.1:9000'})
                except Exception as error:
                    last = {'error': str(error)}
        except Exception as error:
            last = {'error': str(error)}
        time.sleep(0.4)
    raise RuntimeError(f'TCP/PAN telemetry not fresh: {last}')


def finite(values):
    return [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]


def stats(values):
    values = finite(values)
    if not values:
        return None
    return {
        'n': len(values),
        'mean': statistics.mean(values),
        'stdev': statistics.pstdev(values) if len(values) > 1 else 0.0,
        'min': min(values),
        'max': max(values),
        'span': max(values) - min(values),
    }


def median_tail(rows, key, count=25):
    values = finite(r.get(key) for r in rows[-count:])
    return statistics.median(values) if values else None


def sample_row(label, t0, latest):
    servo = (latest.get('servos') or {}).get('PAN') or {}
    motion = (latest.get('servo_motion') or {}).get('PAN') or {}
    adc = latest.get('adc') or []
    # CH6 = PAN pot feedback (raw counts in stream; volts = count * 5/4095 when unscaled).
    ch6 = adc[6] if len(adc) > 6 else None
    pot_v = None
    if isinstance(ch6, (int, float)):
        pot_v = ch6 * 5.0 / 4095.0
    return {
        'sec': round(time.monotonic() - t0, 3),
        'label': label,
        'device_ms': latest.get('device_ms'),
        'pulse': servo.get('pulse'),
        'enable': servo.get('enable'),
        'raw_mode': servo.get('raw'),
        'angle': motion.get('angle'),
        'speed': motion.get('speed'),
        'limit': motion.get('limit'),
        'adc_ch6': ch6,
        'pot_v': pot_v,
    }


def capture(label, seconds, t0, rows, stamp_holder):
    end = time.monotonic() + seconds
    stale_since = None
    while time.monotonic() < end:
        try:
            state = api('state')
        except Exception:
            stale_since = stale_since or time.monotonic()
            if time.monotonic() - stale_since > 12:
                raise RuntimeError('Telemetry went stale during ' + label)
            time.sleep(0.2)
            continue
        latest = state.get('latest') or {}
        age = time.time() - latest.get('received_at', 0)
        if state.get('status') != 'connected' or age > 2:
            stale_since = stale_since or time.monotonic()
            if time.monotonic() - stale_since > 12:
                wait_connected(deadline=20)
                ensure_armed(api('state'))
                stale_since = None
                continue
            time.sleep(0.15)
            continue
        stale_since = None
        mark = latest.get('device_us') or latest.get('device_ms')
        if mark != stamp_holder[0]:
            stamp_holder[0] = mark
            rows.append(sample_row(label, t0, latest))
        time.sleep(0.02)


def ensure_armed(state):
    safety = state.get('servo_safety') or {}
    if args.no_enable:
        if not safety.get('armed') or safety.get('estop'):
            raise RuntimeError('Servos not armed')
        return state
    if safety.get('estop') or (state.get('safety_command') or {}).get('action') == 'ESTOP':
        api('servo-safety', {'action': 'CLEAR'})
        time.sleep(0.4)
    api('servo-safety', {'action': 'ENABLE'})
    time.sleep(0.5)
    state = api('state')
    safety = state.get('servo_safety') or {}
    if not safety.get('armed') or safety.get('estop') or state.get('servo_inhibit'):
        raise RuntimeError(f'Could not arm servos: safety={safety}')
    return state


def pan_pulse(pulse):
    # Continuous-mode axes require continuous=True even for RAW holds.
    pulse = int(round(pulse))
    api('servo', {
        'axis': 'PAN', 'pulse': pulse, 'frequency': 50,
        'manual': True, 'continuous': True,
    })
    _current_pulse[0] = pulse


def wait_pulse(target, timeout=45, tol=1.5):
    """Wait until ESP reports pulse near target and motion.moving cleared."""
    target = int(round(target))
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        state = api('state')
        latest = state.get('latest') or {}
        servo = (latest.get('servos') or {}).get('PAN') or {}
        motion = (latest.get('servo_motion') or {}).get('PAN') or {}
        pulse = servo.get('pulse')
        moving = motion.get('moving')
        last = {'pulse': pulse, 'target': motion.get('target'), 'moving': moving}
        if isinstance(pulse, (int, float)) and abs(pulse - target) <= tol and not moving:
            _current_pulse[0] = int(round(pulse))
            return
        time.sleep(0.05)
    raise RuntimeError(f'Timed out waiting for PAN pulse {target}: {last}')


def pan_ramp_to(target, max_rate=None, accel=None, label=None):
    """Move to target using on-ESP PWM slew (or host microsteps with --host-slew)."""
    target = int(round(target))
    max_rate = float(max_rate if max_rate is not None else args.accel_rate)
    accel = float(accel if accel is not None else args.accel)
    start = _current_pulse[0]
    if label:
        print(json.dumps({
            'ramp': label, 'from': start, 'to': target,
            'mode': 'host' if args.host_slew else 'esp',
            'rate': max_rate, 'accel': accel,
        }), flush=True)
    if not args.host_slew:
        pan_pulse(target)
        wait_pulse(target)
        return
    if start is None:
        pan_pulse(target)
        return
    start = int(start)
    distance = abs(target - start)
    if distance == 0:
        pan_pulse(target)
        return
    if max_rate < 5 or accel < 5:
        raise ValueError('accel-rate and accel must be >= 5 for --host-slew')
    direction = 1 if target > start else -1
    d_accel = 0.5 * max_rate * max_rate / accel
    if 2 * d_accel >= distance:
        peak = math.sqrt(accel * distance)
        t_up = peak / accel
        t_down = t_up
        t_cruise = 0.0
        d_accel = 0.5 * distance
    else:
        peak = max_rate
        t_up = peak / accel
        t_down = t_up
        t_cruise = (distance - 2 * d_accel) / peak
    total = t_up + t_cruise + t_down
    dt = 0.02
    elapsed = 0.0
    while elapsed < total - 1e-9:
        t = min(total, elapsed + dt)
        if t <= t_up:
            pos = 0.5 * accel * t * t
        elif t <= t_up + t_cruise:
            pos = d_accel + peak * (t - t_up)
        else:
            remaining_t = max(0.0, total - t)
            pos = distance - 0.5 * accel * remaining_t * remaining_t
        pos = min(distance, max(0.0, pos))
        pan_pulse(start + direction * int(round(pos)))
        time.sleep(dt)
        elapsed = t
    pan_pulse(target)


def linear_fit(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y))]
    if len(pairs) < 3:
        return None
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom <= 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in pairs) / denom
    intercept = my - slope * mx
    pred = [slope * x + intercept for x in xs]
    ss_res = sum((y - p) ** 2 for y, p in zip(ys, pred))
    ss_tot = sum((y - my) ** 2 for y in ys) or 1.0
    return {
        'n': len(pairs),
        'slope': slope,
        'intercept': intercept,
        'r2': 1.0 - ss_res / ss_tot,
        'rmse': math.sqrt(ss_res / len(pairs)),
    }


def analyze(rows, step_summaries):
    stationary = [r for r in rows if r['label'].startswith('stationary')]
    sweep = [r for r in rows if r['label'].startswith('sweep')]
    report = {
        'stationary_noise': {
            'pot_v': stats(r['pot_v'] for r in stationary),
            'angle': stats(r['angle'] for r in stationary),
            'speed': stats(r['speed'] for r in stationary),
            'adc_ch6': stats(r['adc_ch6'] for r in stationary),
        },
        'steps': step_summaries,
    }
    if step_summaries:
        offsets = [s['offset'] for s in step_summaries]
        report['fit_offset_to_speed'] = linear_fit(offsets, [s['speed'] for s in step_summaries])
        report['fit_offset_to_abs_speed'] = linear_fit(offsets, [abs(s['speed']) if s['speed'] is not None else None for s in step_summaries])
    if sweep:
        report['sweep'] = {
            'samples': len(sweep),
            'speed': stats(r['speed'] for r in sweep),
            'angle': stats(r['angle'] for r in sweep),
            'pot_v': stats(r['pot_v'] for r in sweep),
            'fit_pulse_to_speed': linear_fit([r['pulse'] for r in sweep], [r['speed'] for r in sweep]),
        }
    return report


def main():
    rows = []
    step_summaries = []
    stamp_holder = [None]
    t0 = time.monotonic()
    initial = None
    armed_by_us = False
    finished = False
    saved_limit = None
    saved_osfault = None
    try:
        state = wait_connected()
        latest = state['latest']
        servo = (latest.get('servos') or {}).get('PAN') or {}
        motion = (latest.get('servo_motion') or {}).get('PAN') or {}
        pan = latest.get('pan_config') or {}
        if servo.get('mode') != 1:
            raise RuntimeError('PAN firmware is not continuous mode')
        neutral = int(round(pan.get('neutral') or servo.get('neutral') or 1500))
        end = neutral + args.direction * abs(args.max_offset)
        if not (500 <= end <= 2500 and 10 <= abs(args.max_offset) <= 400):
            raise ValueError('Invalid PAN offset window')
        if not (5 <= args.step <= 100 and 1 <= args.hold <= 15 and 5 <= args.rate <= 200):
            raise ValueError('Invalid step/hold/rate')
        if not (5 <= args.accel_rate <= 200 and 5 <= args.accel <= 2000):
            raise ValueError('Invalid accel-rate/accel')
        _current_pulse[0] = None
        initial = {
            'safety': state.get('servo_safety'),
            'pan_config': pan,
            'servo': {k: servo.get(k) for k in ('neutral', 'mode', 'umin', 'umax', 'pulse')},
            'motion': {k: motion.get(k) for k in ('angle', 'speed', 'limit', 'osfault')},
            'direction': args.direction,
            'window': [neutral, end],
            'trapezoid': {'accel_rate': args.accel_rate, 'accel': args.accel},
        }
        print(json.dumps({'initial': initial}), flush=True)

        print(json.dumps({'phase': 'stationary', 'seconds': args.stationary}), flush=True)
        try:
            api('servo', {'axis': 'PAN', 'off': True})
        except Exception:
            pass
        time.sleep(0.3)
        capture('stationary-off', args.stationary, t0, rows, stamp_holder)

        if not args.skip_steps or not args.skip_sweep:
            before = api('state')
            was_armed = bool((before.get('servo_safety') or {}).get('armed'))
            ensure_armed(before)
            armed_by_us = not was_armed and not args.no_enable
            pan_motion = ((before.get('latest') or {}).get('servo_motion') or {}).get('PAN') or {}
            saved_limit = pan_motion.get('limit')
            saved_osfault = pan_motion.get('osfault')
            # Bypass speed regulation / overspeed trips so commanded PWM is the drive.
            api('servo-speed', {'axis': 'PAN', 'speed': 0})
            time.sleep(0.2)
            if saved_osfault is not None:
                api('servo-overspeed', {'axis': 'PAN', 'enabled': False})
                time.sleep(0.3)
            if not args.host_slew:
                api('servo-pwm-slew', {
                    'axis': 'PAN', 'rate': args.accel_rate, 'accel': args.accel,
                })
                time.sleep(0.3)
            pan_pulse(neutral)
            if not args.host_slew:
                wait_pulse(neutral)
            else:
                time.sleep(0.5)
            capture('stationary-neutral', 2.0, t0, rows, stamp_holder)

        if not args.skip_steps:
            offsets = list(range(args.step, abs(args.max_offset) + 1, args.step))
            if offsets[-1] != abs(args.max_offset):
                offsets.append(abs(args.max_offset))
            print(json.dumps({
                'phase': 'steps', 'direction': args.direction, 'offsets': offsets,
                'trapezoid': {'accel_rate': args.accel_rate, 'accel': args.accel},
            }), flush=True)
            for offset in offsets:
                pulse = neutral + args.direction * offset
                pan_ramp_to(pulse, label=f'accel-{args.direction}-{offset}')
                label = f'step-{args.direction}-{offset}'
                before_n = len(rows)
                capture(label, args.hold, t0, rows, stamp_holder)
                part = rows[before_n:]
                # Use latter half so breakaway/transient is less dominant.
                mid = part[len(part) // 2 :] or part
                summary = {
                    'direction': args.direction,
                    'offset': offset,
                    'pulse': pulse,
                    'speed': statistics.median(finite(r['speed'] for r in mid)) if finite(r['speed'] for r in mid) else None,
                    'angle': median_tail(mid, 'angle'),
                    'pot_v': median_tail(mid, 'pot_v'),
                    'adc_ch6': median_tail(mid, 'adc_ch6'),
                    'samples': len(part),
                }
                step_summaries.append(summary)
                print(json.dumps(summary), flush=True)
                pan_ramp_to(neutral, label=f'decel-{args.direction}-{offset}')
                time.sleep(0.4)

        if not args.skip_sweep:
            # Soft approach into the firmware linear sweep start.
            pan_ramp_to(neutral, label='pre-sweep-neutral')
            print(json.dumps({'phase': 'sweep', 'from': neutral, 'to': end, 'rate': args.rate}), flush=True)
            api('servo-pwm-sweep', {
                'axis': 'PAN', 'action': 'start',
                'start': neutral, 'end': end, 'rate': args.rate,
            })
            duration = abs(end - neutral) / max(args.rate, 1) + 3.0
            capture('sweep-one-way', duration, t0, rows, stamp_holder)
            # STOP would kill output; read actual pulse and trapezoid home instead.
            try:
                actual = (((api('state').get('latest') or {}).get('servos') or {}).get('PAN') or {}).get('pulse')
                _current_pulse[0] = int(round(actual)) if isinstance(actual, (int, float)) else end
            except Exception:
                _current_pulse[0] = end
            pan_ramp_to(neutral, label='post-sweep-decel')
            time.sleep(0.3)

        finished = True
    finally:
        try:
            if _current_pulse[0] is not None and _current_pulse[0] != (initial or {}).get('window', [None])[0]:
                # Best-effort soft stop before OFF if we still know the pulse.
                neutral_guess = (initial or {}).get('window', [1500])[0] or 1500
                pan_ramp_to(neutral_guess, max_rate=min(args.accel_rate, 60), accel=args.accel)
        except Exception:
            pass
        try:
            api('servo-pwm-sweep', {'axis': 'PAN', 'action': 'stop'})
        except Exception:
            pass
        try:
            api('servo', {'axis': 'PAN', 'off': True})
        except Exception as error:
            print('STOP FAILED:', error, flush=True)
        _current_pulse[0] = None
        if saved_osfault is not None:
            try:
                api('servo-overspeed', {'axis': 'PAN', 'enabled': bool(saved_osfault)})
            except Exception:
                pass
        if saved_limit is not None:
            try:
                api('servo-speed', {'axis': 'PAN', 'speed': saved_limit})
            except Exception:
                pass
        if armed_by_us:
            try:
                api('servo-safety', {'action': 'DISABLE'})
            except Exception:
                pass
        if rows or step_summaries:
            report = analyze(rows, step_summaries)
            stamp = time.strftime('%Y%m%d-%H%M%S')
            out = Path(__file__).resolve().parent / f'pan-sensor-characterization-{stamp}.json'
            payload = {
                'initial': initial,
                'args': vars(args),
                'summary': report,
                'rows': rows,
                'aborted': not finished,
            }
            out.write_text(json.dumps(payload, indent=2))
            print(json.dumps({
                'saved': str(out),
                'samples': len(rows),
                'aborted': not finished,
                'summary': report,
            }, indent=2), flush=True)


if __name__ == '__main__':
    try:
        main()
    except urllib.error.URLError as error:
        raise SystemExit(f'Relay unreachable at {args.base}: {error}') from error
