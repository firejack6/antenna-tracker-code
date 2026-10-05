"""Check firmware gating and stop acknowledgements on COM8; briefly pulse TILT."""
import time
import serial
from adc_protocol import Stream

lines = []
stream = Stream(lines.append, lambda records, packet: None, lambda: None)
with serial.Serial('COM8', 115200, timeout=.05) as device:
    device.dtr = True
    device.rts = False
    device.reset_input_buffer()

    def command(text, expected):
        first = len(lines)
        device.write((text + '\n').encode())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            stream.feed(device.read(min(device.in_waiting or 1, 65536)))
            if expected in lines[first:]:
                print('PASS:', text, '->', expected)
                return
        raise RuntimeError((text, expected, lines[first:][-12:]))

    try:
        command('SERVOS CLEAR', 'Servo safety: ARMED=0 ESTOP=0')
        command('SERVO TILT 1500 50', 'Servo error: servos disabled; enable first')
        command('SERVOS ENABLE', 'Servo safety: ARMED=1 ESTOP=0')
        command('SERVO TILT 1500 50', 'Servo ack: TILT PULSE=1500 FREQ=50 ENABLE=1')
        command('SERVOS ESTOP', 'Servo safety: ARMED=0 ESTOP=1')
        deadline = time.monotonic() + 3
        first = len(lines)
        while time.monotonic() < deadline:
            stream.feed(device.read(min(device.in_waiting or 1, 65536)))
            if all(any(line.startswith('Servo ' + axis + ':') and 'ENABLE=0 READY=1' in line
                       for line in lines[first:]) for axis in ('PAN', 'TILT', 'S3')):
                print('PASS: E-stop telemetry confirms all three PWM outputs OFF')
                break
        else:
            raise RuntimeError('All-output OFF telemetry missing after E-stop')
        command('SERVO TILT 1500 50', 'Servo error: E-stop latched')
        command('SERVOS ENABLE', 'Servo error: E-stop latched; clear it before enabling')
        command('SERVO TILT OFF', 'Servo ack: TILT PULSE=1500 FREQ=50 ENABLE=0')
        command('SERVOS CLEAR', 'Servo safety: ARMED=0 ESTOP=0')
        command('SERVO TILT 1500 50', 'Servo error: servos disabled; enable first')
        command('SERVOS ENABLE', 'Servo safety: ARMED=1 ESTOP=0')
        command('SERVOS DISABLE', 'Servo safety: ARMED=0 ESTOP=0')
    finally:
        device.write(b'SERVOS CLEAR\nSERVOS DISABLE\nSERVO TILT OFF\n')
