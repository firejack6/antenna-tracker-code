"""Decode ATS1 binary status frames into dashboard telemetry dicts."""
from __future__ import annotations
import math
import struct

MAGIC_STATUS = b'\x00ATS1'

_SERVO = struct.Struct('<17i')
_MOTION = struct.Struct('<8fI2i')
_PID = struct.Struct('<9f3i')
_POS = struct.Struct('<10f2i')
_HEADER = struct.Struct('<I3i3f4I8I3I4i4i2i')
_PAN = struct.Struct('<8f')
_TILT = struct.Struct('<12f5i')
_IMU = struct.Struct('<6f3iQ2I')
_SENSORS = struct.Struct('<9f3ifQ')
# 14f+4i + CR(6f) + breakaway(2f) + schedule(7f: kp/ki/kd/cap/span/brk/settle)
# + adc_hz(f) + stream(i) + wifi(i) + pan_fb(i)
_CFG = struct.Struct('<14f4i16fiii')
# Pre–near-I/D firmware (schedule 5f + pan_fb).
_CFG_FEEDBACK = struct.Struct('<14f4i14fiii')
# Schedule generation without pan_fb (pre–mag-feedback firmware).
_CFG_SCHEDULE = struct.Struct('<14f4i14fii')
# Breakaway only (no schedule).
_CFG_BREAKAWAY = struct.Struct('<14f4i9fii')
# Pre-breakaway firmware.
_CFG_LEGACY = struct.Struct('<14f4i7fii')

_PREFIX = (
    _HEADER.size + 3 * _SERVO.size + 2 * _MOTION.size + 2 * _PID.size + 2 * _POS.size
    + _PAN.size + _TILT.size + _IMU.size + _SENSORS.size
)
STATUS_SIZE = _PREFIX + _CFG.size
STATUS_SIZE_FEEDBACK = _PREFIX + _CFG_FEEDBACK.size
STATUS_SIZE_SCHEDULE = _PREFIX + _CFG_SCHEDULE.size
STATUS_SIZE_BREAKAWAY = _PREFIX + _CFG_BREAKAWAY.size
STATUS_SIZE_LEGACY = _PREFIX + _CFG_LEGACY.size

AXES = ('PAN', 'TILT', 'S3')


def _finite(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else None


def decode_status(payload: bytes) -> dict:
    if len(payload) == STATUS_SIZE:
        cfg_fmt, generation = _CFG, 'near_pid'
    elif len(payload) == STATUS_SIZE_FEEDBACK:
        cfg_fmt, generation = _CFG_FEEDBACK, 'feedback'
    elif len(payload) == STATUS_SIZE_SCHEDULE:
        cfg_fmt, generation = _CFG_SCHEDULE, 'schedule'
    elif len(payload) == STATUS_SIZE_BREAKAWAY:
        cfg_fmt, generation = _CFG_BREAKAWAY, 'breakaway'
    elif len(payload) == STATUS_SIZE_LEGACY:
        cfg_fmt, generation = _CFG_LEGACY, 'legacy'
    else:
        raise ValueError(
            f'ATS1 size {len(payload)} != {STATUS_SIZE}, {STATUS_SIZE_FEEDBACK}, '
            f'{STATUS_SIZE_SCHEDULE}, {STATUS_SIZE_BREAKAWAY}, or {STATUS_SIZE_LEGACY}')
    offset = 0

    def take(fmt: struct.Struct):
        nonlocal offset
        values = fmt.unpack_from(payload, offset)
        offset += fmt.size
        return values

    h = take(_HEADER)
    (device_ms, adc_channel, adc_spi, adc_quiet,
     rate_adc, rate_bmi, rate_mag,
     missed, drops, invalid, maxscan,
     queued, capacity, stalls, failed, maxwrite, connections, pending, close_reason,
     commands, cmdmax, ctrlmax,
     accel_range, gyro_range, mag_range, ranges_ready,
     gpio46, gpio4, gpio13, gpio14,
     armed, estop) = h

    servos = {}
    for name in AXES:
        (gpio, pmin, pcenter, pmax, fmin, fcenter, fmax,
         pulse, freq, enable, ready, umin, ucenter, umax, mode, neutral, raw) = take(_SERVO)
        servos[name] = dict(
            gpio=gpio, pmin=pmin, pcenter=pcenter, pmax=pmax, fmin=fmin, fcenter=fcenter, fmax=fmax,
            pulse=pulse, freq=freq, enable=enable, ready=ready, umin=umin, ucenter=ucenter, umax=umax,
            mode=mode, neutral=neutral, raw=raw)

    # Firmware packs parallel arrays (motion[2], pid[2], position[2]), not per-axis
    # interleaved blocks. Keep this aligned with status_frame.h / fillServoStatus.
    servo_motion, servo_pid, servo_position = {}, {}, {}
    for name in ('PAN', 'TILT'):
        angle, speed, limit, commandspeed, minangle, maxangle, slew_rate, slew_accel, target, moving, osfault = take(_MOTION)
        servo_motion[name] = dict(
            angle=_finite(angle), speed=_finite(speed), limit=_finite(limit),
            commandspeed=_finite(commandspeed), minangle=_finite(minangle), maxangle=_finite(maxangle),
            slew_rate=_finite(slew_rate), slew_accel=_finite(slew_accel),
            target=target, moving=moving, osfault=osfault)
    for name in ('PAN', 'TILT'):
        setpoint, error, p, i, d, ff, startup, request, output, active, phase, mode = take(_PID)
        servo_pid[name] = dict(
            setpoint=_finite(setpoint), error=_finite(error), p=_finite(p), i=_finite(i), d=_finite(d),
            ff=_finite(ff), startup=_finite(startup), request=_finite(request), output=_finite(output),
            active=active, phase=phase, mode=mode)
    for name in ('PAN', 'TILT'):
        target, kp, ki, kd, ilimit, cap, tolerance, dbplus, dbminus, ramprate, active, ramp = take(_POS)
        servo_position[name] = dict(
            target=_finite(target), kp=_finite(kp), ki=_finite(ki), kd=_finite(kd),
            ilimit=_finite(ilimit), cap=_finite(cap), tolerance=_finite(tolerance),
            dbplus=_finite(dbplus), dbminus=_finite(dbminus), ramprate=_finite(ramprate),
            active=active, ramp=ramp)

    pan = take(_PAN)
    pan_config = dict(neutral=pan[0], polarity=pan[1], vmin=pan[2], vmax=pan[3],
                      span=pan[4], zero=pan[5], amin=pan[6], amax=pan[7])
    pan_config = {k: _finite(v) for k, v in pan_config.items()}

    tilt = take(_TILT)
    tilt_config = dict(
        vmin=_finite(tilt[0]), vmax=_finite(tilt[1]), zero=_finite(tilt[2]),
        amin=_finite(tilt[3]), amax=_finite(tilt[4]), volts=_finite(tilt[5]),
        sweep=tilt[12], smin=_finite(tilt[6]), smax=_finite(tilt[7]),
        progress=_finite(tilt[8]), reason=tilt[13], cap=_finite(tilt[9]),
        poldir=tilt[14], filtered=_finite(tilt[10]), minpwm=_finite(tilt[11]),
        rotations=tilt[15], wrap=tilt[16])

    imu = take(_IMU)
    tilt_imu = dict(
        angle=_finite(imu[0]), speed=_finite(imu[1]), raw=_finite(imu[2]), zero=_finite(imu[3]),
        amin=_finite(imu[4]), amax=_finite(imu[5]), axis=imu[6], ready=imu[7], active=imu[8],
        us=imu[9], pmin=imu[10], pmax=imu[11])

    sensors = take(_SENSORS)
    accel = [_finite(sensors[i]) for i in range(3)]
    gyro = [_finite(sensors[i]) for i in range(3, 6)]
    mag = [_finite(sensors[i]) for i in range(6, 9)]
    bmi_valid, mag_valid, range_failed = sensors[9:12]
    chip_temp_c, chip_temp_us = sensors[12], sensors[13]

    cfg = take(cfg_fmt)
    pan_breakaway_us = pan_breakaway_ms = None
    pan_kp_near = pan_ki_near = pan_kd_near = pan_cap_near = None
    pan_schedule_deg = pan_brk_min_scale = pan_settle_deg = None
    pan_fb = None
    if generation == 'legacy':
        adc_sample_hz, adc_stream, wifi_ap = _finite(cfg[24]), cfg[25], cfg[26]
    elif generation == 'breakaway':
        pan_breakaway_us, pan_breakaway_ms = _finite(cfg[24]), _finite(cfg[25])
        adc_sample_hz, adc_stream, wifi_ap = _finite(cfg[26]), cfg[27], cfg[28]
    elif generation == 'schedule':
        pan_breakaway_us, pan_breakaway_ms = _finite(cfg[24]), _finite(cfg[25])
        pan_kp_near, pan_cap_near = _finite(cfg[26]), _finite(cfg[27])
        pan_schedule_deg, pan_brk_min_scale, pan_settle_deg = _finite(cfg[28]), _finite(cfg[29]), _finite(cfg[30])
        adc_sample_hz, adc_stream, wifi_ap = _finite(cfg[31]), cfg[32], cfg[33]
    elif generation == 'feedback':
        pan_breakaway_us, pan_breakaway_ms = _finite(cfg[24]), _finite(cfg[25])
        pan_kp_near, pan_cap_near = _finite(cfg[26]), _finite(cfg[27])
        pan_schedule_deg, pan_brk_min_scale, pan_settle_deg = _finite(cfg[28]), _finite(cfg[29]), _finite(cfg[30])
        adc_sample_hz, adc_stream, wifi_ap = _finite(cfg[31]), cfg[32], cfg[33]
        pan_fb = cfg[34]
    else:
        pan_breakaway_us, pan_breakaway_ms = _finite(cfg[24]), _finite(cfg[25])
        pan_kp_near, pan_ki_near, pan_kd_near = _finite(cfg[26]), _finite(cfg[27]), _finite(cfg[28])
        pan_cap_near = _finite(cfg[29])
        pan_schedule_deg, pan_brk_min_scale, pan_settle_deg = _finite(cfg[30]), _finite(cfg[31]), _finite(cfg[32])
        adc_sample_hz, adc_stream, wifi_ap = _finite(cfg[33]), cfg[34], cfg[35]
        pan_fb = cfg[36]
    effective_config = dict(
        pan_speed=_finite(cfg[0]), tilt_speed=_finite(cfg[1]),
        pan_ramp_rate=_finite(cfg[2]), tilt_ramp_rate=_finite(cfg[3]),
        pan_dbplus=_finite(cfg[4]), pan_dbminus=_finite(cfg[5]),
        tilt_dbplus=_finite(cfg[6]), tilt_dbminus=_finite(cfg[7]),
        pan_kp=_finite(cfg[8]), pan_ki=_finite(cfg[9]), pan_kd=_finite(cfg[10]),
        tilt_kp=_finite(cfg[11]), tilt_ki=_finite(cfg[12]), tilt_kd=_finite(cfg[13]),
        pan_ramp=cfg[14], tilt_ramp=cfg[15], pan_osfault=cfg[16], tilt_osfault=cfg[17],
        pan_ff=_finite(cfg[18]), pan_rise=_finite(cfg[19]), pan_fall=_finite(cfg[20]),
        pan_search=_finite(cfg[21]), pan_search_max=_finite(cfg[22]), pan_brake=_finite(cfg[23]),
        pan_breakaway_us=pan_breakaway_us, pan_breakaway_ms=pan_breakaway_ms,
        pan_kp_near=pan_kp_near, pan_ki_near=pan_ki_near, pan_kd_near=pan_kd_near,
        pan_cap_near=pan_cap_near, pan_schedule_deg=pan_schedule_deg,
        pan_brk_min_scale=pan_brk_min_scale, pan_settle_deg=pan_settle_deg,
        pan_fb=pan_fb,
        adc_sample_hz=adc_sample_hz, adc_stream=adc_stream, wifi_ap=wifi_ap)

    if offset != len(payload):
        raise ValueError('ATS1 unpack did not consume payload')

    frame = dict(
        device_ms=device_ms,
        adc_mode=dict(channel=adc_channel, spi=adc_spi, quiet=adc_quiet),
        rates=dict(adc=rate_adc, bmi=rate_bmi, mag=rate_mag, missed=missed, drops=drops,
                   invalid=invalid, maxscan=maxscan),
        link_health=dict(queued=queued, capacity=capacity, stalls=stalls, failed=failed,
                         maxwrite=maxwrite, connections=connections, pending=pending,
                         close=close_reason, commands=commands, cmdmax=cmdmax, ctrlmax=ctrlmax),
        ranges=dict(accel=accel_range, gyro=gyro_range, mag=mag_range, ready=ranges_ready),
        gpio={'46': gpio46, '4': gpio4, '13': gpio13, '14': gpio14},
        servos=servos, servo_motion=servo_motion, servo_pid=servo_pid, servo_position=servo_position,
        pan_config=pan_config, tilt_config=tilt_config, tilt_imu=tilt_imu,
        accel=accel if bmi_valid else None, gyro=gyro if bmi_valid else None,
        mag=mag if mag_valid else None, errors=[],
        effective_config=effective_config,
        _armed=armed, _estop=estop,
        _chip_temp_c=_finite(chip_temp_c), _chip_temp_us=chip_temp_us,
        _range_failed=range_failed,
    )
    return frame
