import time
import unittest
from relay import Relay


class ServoPwmSweepTests(unittest.TestCase):
    def ready(self, axis='TILT'):
        relay = Relay()
        relay.status = 'connected'
        relay.log('Servo safety: ARMED=1 ESTOP=0')
        relay.sample(dict(
            received_at=time.time(),
            servos={
                axis: dict(ready=1, pmin=500, pmax=2500, fmin=50, fcenter=50, fmax=50),
            },
        ))
        return relay

    def drain(self, relay):
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        return writes

    def test_start_emits_absolute_pwm_sweep_command(self):
        relay = self.ready()
        relay.command_servo_pwm_sweep(dict(axis='TILT', action='start', start=500, end=2500, rate=40))
        self.assertEqual(self.drain(relay), [b'SERVO PWM SWEEP TILT 500 2500 40 50\n'])

    def test_stop_uses_priority_queue(self):
        relay = self.ready('PAN')
        relay.command_servo_pwm_sweep(dict(axis='PAN', action='stop'))
        self.assertEqual(self.drain(relay), [b'SERVO PWM SWEEP PAN STOP\n'])

    def test_rejects_equal_endpoints(self):
        relay = self.ready()
        with self.assertRaisesRegex(ValueError, 'differ'):
            relay.command_servo_pwm_sweep(dict(axis='TILT', action='start', start=1500, end=1500, rate=40))

    def test_rejects_rate_out_of_range(self):
        relay = self.ready()
        with self.assertRaisesRegex(ValueError, '5–200'):
            relay.command_servo_pwm_sweep(dict(axis='TILT', action='start', start=500, end=2500, rate=1))

    def test_requires_armed_servos_to_start(self):
        relay = self.ready()
        relay.log('Servo safety: ARMED=0 ESTOP=0')
        with self.assertRaisesRegex(ValueError, 'Enable servos'):
            relay.command_servo_pwm_sweep(dict(axis='TILT', action='start', start=500, end=2500, rate=40))

    def test_stop_allowed_when_disarmed(self):
        relay = self.ready('S3')
        relay.log('Servo safety: ARMED=0 ESTOP=0')
        relay.command_servo_pwm_sweep(dict(axis='S3', action='stop'))
        self.assertEqual(self.drain(relay), [b'SERVO PWM SWEEP S3 STOP\n'])

    def test_pwm_slew_emits_command(self):
        relay = self.ready('PAN')
        relay.command_servo_pwm_slew(dict(axis='PAN', rate=40, accel=80))
        self.assertEqual(self.drain(relay), [b'SERVO PWM SLEW PAN 40 80\n'])

    def test_pwm_slew_zero_disables(self):
        relay = self.ready()
        relay.command_servo_pwm_slew(dict(axis='TILT', rate=0, accel=0))
        self.assertEqual(self.drain(relay), [b'SERVO PWM SLEW TILT 0 0\n'])

    def test_pwm_slew_rejects_out_of_range(self):
        relay = self.ready()
        with self.assertRaisesRegex(ValueError, '0–500'):
            relay.command_servo_pwm_slew(dict(axis='TILT', rate=600, accel=80))


if __name__ == '__main__':
    unittest.main()
