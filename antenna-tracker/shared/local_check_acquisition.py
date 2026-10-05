"""Measure native USB on the attached machine; no servo commands."""
import argparse
import json
import time
import serial
from adc_protocol import Stream

args = argparse.ArgumentParser()
args.add_argument('--port', default='COM8')
args.add_argument('--seconds', type=float, default=10)
args.add_argument('--probe', action='store_true', help='Check command reception with TILT OFF (no PWM enabled)')
args.add_argument('--pulse-probe', action='store_true', help='Briefly command TILT 1500 us/50 Hz, then switch it OFF')
args.add_argument('--channel-probe', type=int, choices=range(16), help='Select one ADC channel, then restore ALL; no servo commands')
options = args.parse_args()
stats = dict(scans=0, bytes=0, corrupt=0, gaps=0)
first_us = last_us = last_sequence = None
rates = []
def line(text):
    if text.startswith(('ADC mode:', 'GPIO states:', 'Servo safety:', 'Servo PAN:', 'Servo TILT:', 'Servo S3:')):
        key = text.split(':', 1)[0]
        stats.setdefault('hardware_status', {})[key] = text.split(':', 1)[1].strip()
    if text.startswith(('Rates:', 'Ranges:', 'Sensor error:', 'Servo ack:', 'Servo error:', 'BMI323 unavailable', 'BMM350 unavailable')):
        rates.append(text)
def corrupt(): stats['corrupt'] += 1
def batch(records, packet):
    global first_us, last_us, last_sequence
    for seq, stamp, *_ in records:
        if first_us is None: first_us = stamp
        if last_sequence is not None and stamp >= last_us: stats['gaps'] += (seq - last_sequence - 1) & 0xFFFFFFFF
        last_sequence, last_us = seq, stamp
    stats['scans'] += len(records)
    stats['last_valid_mask'] = records[-1][2]
    stats['last_raw_channels'] = list(records[-1][3:])
    stats['last_input_volts'] = [round(raw * 5.0 / 4096, 6) for raw in records[-1][3:]]
    if options.channel_probe is not None:
        channel = options.channel_probe
        for record in records:
            if record[2] == 1 << channel:
                raw = record[3 + channel]
                values = stats.setdefault('diagnostic', dict(channel=channel, count=0, min=4095, max=0, sum=0))
                values['count'] += 1; values['sum'] += raw
                values['min'] = min(values['min'], raw); values['max'] = max(values['max'], raw)
stream = Stream(line, batch, corrupt)
with serial.Serial(options.port, 115200, timeout=.05) as device:
    device.dtr = True; device.rts = False
    device.reset_input_buffer()
    if options.probe: device.write(b'SERVO TILT OFF\n')
    if options.channel_probe is not None: device.write(f'ADC CHANNEL {options.channel_probe}\n'.encode())
    started = time.monotonic()
    if options.pulse_probe: device.write(b'SERVOS ENABLE\nSERVO TILT 1500 50\n')
    off_sent = False
    try:
        while time.monotonic() - started < options.seconds:
            if options.pulse_probe and not off_sent and time.monotonic() - started >= .5:
                device.write(b'SERVO TILT OFF\n'); off_sent = True
            data = device.read(min(device.in_waiting or 1, 65536))
            stats['bytes'] += len(data); stream.feed(data)
    finally:
        if options.pulse_probe: device.write(b'SERVO TILT OFF\nSERVOS DISABLE\n')
        if options.channel_probe is not None:
            device.write(b'ADC CHANNEL ALL\n')
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                stream.feed(device.read(min(device.in_waiting or 1, 65536)))
                if stats.get('hardware_status', {}).get('ADC mode', '').startswith('CHANNEL=-1 '):
                    stats['normal_restored'] = True; break
elapsed = time.monotonic() - started
stats.update(elapsed=round(elapsed, 3), scans_per_wall_s=round(stats['scans']/elapsed, 1),
             latest_status=rates[-8:])
if options.probe or options.pulse_probe:
    stats['control_acknowledged'] = any(line.startswith('Servo ack: TILT ') and line.endswith('ENABLE=0') for line in rates)
    stats['control_messages'] = [line for line in rates if line.startswith(('Servo ack:', 'Servo error:'))]
if options.pulse_probe:
    stats['pwm_acknowledged'] = 'Servo ack: TILT PULSE=1500 FREQ=50 ENABLE=1' in rates
if first_us is not None and last_us > first_us:
    stats['scans_per_device_s'] = round((stats['scans']-1)*1e6/(last_us-first_us), 1)
print(json.dumps(stats, indent=2))
if options.channel_probe is not None and (not stats.get('diagnostic', {}).get('count') or not stats.get('normal_restored')):
    raise RuntimeError('Single-channel selection or normal-mode restore was not confirmed')
if options.probe and not stats['control_acknowledged']: raise RuntimeError('No firmware acknowledgement for TILT OFF')
if options.pulse_probe and not (stats['pwm_acknowledged'] and stats['control_acknowledged']):
    raise RuntimeError('TILT PWM enable/OFF acknowledgement check failed')
