"""TILT hardware characterization: pot vs IMU vs PWM (and gyro).

Requires a live dashboard relay with TCP connected to the board.
Default travel uses the IMU-mapped PWM window (typically 900–2000 µs), not full 500–2500.

Phases:
  1. stationary — noise floor (pot, IMU, gyro) with output off
  2. steps     — RAW holds across the PWM window; settle then sample
  3. sweep     — firmware SERVO PWM SWEEP up then down while logging

Writes a JSON capture + prints a short comparison summary.
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
parser.add_argument('--start', type=int, default=None, help='Sweep/step start µs (default: IMU pmin or 900)')
parser.add_argument('--end', type=int, default=None, help='Sweep/step end µs (default: IMU pmax or 2000)')
parser.add_argument('--step', type=int, default=100, help='RAW step size µs')
parser.add_argument('--hold', type=float, default=2.5, help='Seconds to settle at each RAW step')
parser.add_argument('--stationary', type=float, default=5.0, help='Seconds of noise capture with output off')
parser.add_argument('--rate', type=float, default=40.0, help='PWM sweep rate µs/s')
parser.add_argument('--inset', type=int, default=0,
                    help='Shrink start/end inward by this many µs to stay clear of servo deadzones')
parser.add_argument('--skip-sweep', action='store_true')
parser.add_argument('--skip-steps', action='store_true')
parser.add_argument('--no-enable', action='store_true', help='Do not ENABLE/CLEAR; assume already armed')
args = parser.parse_args()


def api(path, data=None, timeout=3):
    path = 'state?since=2147483647' if path == 'state' else path
    request = urllib.request.Request(
        args.base.rstrip('/') + '/api/' + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def wait_connected(deadline=45, reconnect=True):
    end = time.monotonic() + deadline
    last = None
    attempted = False
    while time.monotonic() < end:
        try:
            state = api('state')
            last = state
            latest = state.get('latest') or {}
            age = time.time() - latest.get('received_at', 0)
            if state.get('status') == 'connected' and age < 2 and latest.get('tilt_imu'):
                return state
            if reconnect and not attempted and state.get('status') != 'connected':
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
    raise RuntimeError(f'TCP/IMU telemetry not fresh: {last}')


def sample_row(label, t0, latest):
    imu = latest.get('tilt_imu') or {}
    tilt = latest.get('tilt_config') or {}
    servo = (latest.get('servos') or {}).get('TILT') or {}
    motion = (latest.get('servo_motion') or {}).get('TILT') or {}
    gyro = latest.get('gyro') or [None, None, None]
    adc = latest.get('adc') or []
    # CH7 is TILT pot feedback; keep both protocol volts and raw ADC as fallback.
    pot_v = tilt.get('volts')
    if pot_v is None and len(adc) > 7 and isinstance(adc[7], (int, float)):
        pot_v = adc[7]
    return {
        'sec': round(time.monotonic() - t0, 3),
        'label': label,
        'device_ms': latest.get('device_ms'),
        'pulse': servo.get('pulse'),
        'enable': servo.get('enable'),
        'raw_mode': servo.get('raw'),
        'pot_v': pot_v,
        'pot_filtered': tilt.get('filtered'),
        'adc_ch7': adc[7] if len(adc) > 7 else None,
        'imu_angle': imu.get('angle'),
        'imu_raw': imu.get('raw'),
        'imu_speed': imu.get('speed'),
        'imu_us': imu.get('us'),
        'motion_angle': motion.get('angle'),
        'motion_speed': motion.get('speed'),
        'gyro_y': gyro[1] if len(gyro) > 1 else None,
        'gyro_x': gyro[0] if len(gyro) > 0 else None,
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
        imu = latest.get('tilt_imu') or {}
        mark = imu.get('us') or latest.get('device_us')
        if mark != stamp_holder[0]:
            stamp_holder[0] = mark
            rows.append(sample_row(label, t0, latest))
        time.sleep(0.02)


def finite(values):
    return [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]


def stats(values):
    values = finite(values)
    if not values:
        return None
    mean = statistics.mean(values)
    return {
        'n': len(values),
        'mean': mean,
        'stdev': statistics.pstdev(values) if len(values) > 1 else 0.0,
        'min': min(values),
        'max': max(values),
        'span': max(values) - min(values),
    }


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


def median_tail(rows, key, count=20):
    values = finite(r.get(key) for r in rows[-count:])
    return statistics.median(values) if values else None


def analyze(rows, step_summaries):
    stationary = [r for r in rows if r['label'] == 'stationary']
    sweep = [r for r in rows if r['label'].startswith('sweep')]
    report = {
        'stationary_noise': {
            'pot_v': stats(r['pot_v'] for r in stationary),
            'imu_angle': stats(r['imu_angle'] for r in stationary),
            'imu_speed': stats(r['imu_speed'] for r in stationary),
            'gyro_y': stats(r['gyro_y'] for r in stationary),
        },
        'steps': step_summaries,
    }
    if step_summaries:
        pulses = [s['pulse'] for s in step_summaries]
        report['fit_pwm_to_imu'] = linear_fit(pulses, [s['imu_angle'] for s in step_summaries])
        report['fit_pwm_to_pot'] = linear_fit(pulses, [s['pot_v'] for s in step_summaries])
        report['fit_pot_to_imu'] = linear_fit([s['pot_v'] for s in step_summaries], [s['imu_angle'] for s in step_summaries])
        ascending = [s for s in step_summaries if s.get('direction') == 'up']
        descending = [s for s in step_summaries if s.get('direction') == 'down']
        if ascending and descending:
            # Match nearest pulses for hysteresis (IMU and pot).
            hyst = []
            for up in ascending:
                downs = sorted(descending, key=lambda d: abs(d['pulse'] - up['pulse']))
                if not downs or abs(downs[0]['pulse'] - up['pulse']) > 5:
                    continue
                down = downs[0]
                if None not in (up['imu_angle'], down['imu_angle'], up['pot_v'], down['pot_v']):
                    hyst.append({
                        'pulse': up['pulse'],
                        'imu_delta': down['imu_angle'] - up['imu_angle'],
                        'pot_delta': down['pot_v'] - up['pot_v'],
                    })
            if hyst:
                report['hysteresis'] = {
                    'points': hyst,
                    'imu_mean_abs': statistics.mean(abs(h['imu_delta']) for h in hyst),
                    'pot_mean_abs': statistics.mean(abs(h['pot_delta']) for h in hyst),
                }
    if sweep:
        report['sweep'] = {
            'samples': len(sweep),
            'fit_pwm_to_imu': linear_fit([r['pulse'] for r in sweep], [r['imu_angle'] for r in sweep]),
            'fit_pwm_to_pot': linear_fit([r['pulse'] for r in sweep], [r['pot_v'] for r in sweep]),
            'fit_pot_to_imu': linear_fit([r['pot_v'] for r in sweep], [r['imu_angle'] for r in sweep]),
            'imu_span': stats(r['imu_angle'] for r in sweep),
            'pot_span': stats(r['pot_v'] for r in sweep),
        }
    return report


def ensure_armed(state):
    safety = state.get('servo_safety') or {}
    if args.no_enable:
        if not safety.get('armed') or safety.get('estop'):
            raise RuntimeError('Servos not armed; clear ESTOP / enable in the UI, or omit --no-enable')
        return
    if safety.get('estop') or (state.get('safety_command') or {}).get('action') == 'ESTOP':
        api('servo-safety', {'action': 'CLEAR'})
        time.sleep(0.4)
    api('servo-safety', {'action': 'ENABLE'})
    time.sleep(0.5)
    state = api('state')
    safety = state.get('servo_safety') or {}
    if not safety.get('armed') or safety.get('estop') or state.get('servo_inhibit'):
        raise RuntimeError(f'Could not arm servos: safety={safety} inhibit={state.get("servo_inhibit")}')
    return state


def main():
    rows = []
    step_summaries = []
    stamp_holder = [None]
    t0 = time.monotonic()
    initial = None
    armed_by_us = False
    finished = False
    try:
        state = wait_connected()
        latest = state['latest']
        imu = latest.get('tilt_imu') or {}
        start = args.start if args.start is not None else int(imu.get('pmin') or 900)
        end = args.end if args.end is not None else int(imu.get('pmax') or 2000)
        if args.inset:
            start += abs(args.inset)
            end -= abs(args.inset)
        if not (500 <= start < end <= 2500):
            raise ValueError(f'Need 500 ≤ start < end ≤ 2500; got {start}–{end}')
        if not (20 <= args.step <= 500 and 1 <= args.hold <= 15 and 5 <= args.rate <= 200):
            raise ValueError('Invalid step/hold/rate bounds')
        if args.inset and (end - start) < 100:
            raise ValueError('Inset left too little travel; reduce --inset')
        initial = {
            'safety': state.get('servo_safety'),
            'imu': {k: imu.get(k) for k in ('angle', 'raw', 'amin', 'amax', 'pmin', 'pmax', 'axis', 'ready', 'active')},
            'tilt_volts': (latest.get('tilt_config') or {}).get('volts'),
            'window': [start, end],
            'inset_us': args.inset,
            'rate_us_per_s': args.rate,
        }
        print(json.dumps({'initial': initial}), flush=True)

        print(json.dumps({'phase': 'stationary', 'seconds': args.stationary}), flush=True)
        try:
            api('servo', {'axis': 'TILT', 'off': True})
        except Exception:
            pass
        time.sleep(0.3)
        capture('stationary', args.stationary, t0, rows, stamp_holder)
        print(json.dumps({'stationary': analyze(rows, [])['stationary_noise']}), flush=True)

        if not args.skip_steps or not args.skip_sweep:
            before = api('state')
            was_armed = bool((before.get('servo_safety') or {}).get('armed'))
            ensure_armed(before)
            armed_by_us = not was_armed and not args.no_enable

        if not args.skip_steps:
            ascending = list(range(start, end + 1, args.step))
            if ascending[-1] != end:
                ascending.append(end)
            descending = list(reversed(ascending))
            for direction, sequence in (('up', ascending), ('down', descending)):
                print(json.dumps({'phase': 'steps', 'direction': direction, 'pulses': sequence}), flush=True)
                for pulse in sequence:
                    api('servo', {'axis': 'TILT', 'pulse': pulse, 'frequency': 50, 'manual': True})
                    label = f'step-{direction}-{pulse}'
                    before_n = len(rows)
                    capture(label, args.hold, t0, rows, stamp_holder)
                    part = rows[before_n:]
                    summary = {
                        'direction': direction,
                        'pulse': pulse,
                        'imu_angle': median_tail(part, 'imu_angle'),
                        'imu_raw': median_tail(part, 'imu_raw'),
                        'pot_v': median_tail(part, 'pot_v'),
                        'pot_filtered': median_tail(part, 'pot_filtered'),
                        'imu_speed': median_tail(part, 'imu_speed'),
                        'gyro_y': median_tail(part, 'gyro_y'),
                        'samples': len(part),
                    }
                    step_summaries.append(summary)
                    print(json.dumps(summary), flush=True)

        if not args.skip_sweep:
            for direction, a, b in (('up', start, end), ('down', end, start)):
                print(json.dumps({'phase': 'sweep', 'direction': direction, 'from': a, 'to': b, 'rate': args.rate}), flush=True)
                api('servo-pwm-sweep', {'axis': 'TILT', 'action': 'start', 'start': a, 'end': b, 'rate': args.rate})
                label = f'sweep-{direction}'
                # Duration = travel / rate + margin
                duration = abs(b - a) / max(args.rate, 1) + 3.0
                capture(label, duration, t0, rows, stamp_holder)
                api('servo-pwm-sweep', {'axis': 'TILT', 'action': 'stop'})
                time.sleep(0.4)
        finished = True

    finally:
        try:
            api('servo-pwm-sweep', {'axis': 'TILT', 'action': 'stop'})
        except Exception:
            pass
        try:
            api('servo', {'axis': 'TILT', 'off': True})
        except Exception as error:
            print('STOP FAILED:', error, flush=True)
        if armed_by_us:
            try:
                api('servo-safety', {'action': 'DISABLE'})
            except Exception:
                pass
        if rows or step_summaries:
            report = analyze(rows, step_summaries)
            stamp = time.strftime('%Y%m%d-%H%M%S')
            out = Path(__file__).resolve().parent / f'tilt-sensor-characterization-{stamp}.json'
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
