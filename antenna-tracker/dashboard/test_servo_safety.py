import time
import unittest
from relay import Relay


class SafetyTests(unittest.TestCase):
    def ready(self):
        relay = Relay()
        relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), servos={'TILT': dict(ready=1, pmin=500, pmax=2500, fmin=50, fmax=50)}))
        return relay

    def test_defaults_disabled_and_board_confirmation_required_for_enable(self):
        relay = self.ready()
        with self.assertRaises(ValueError): relay.command_servo(dict(axis='TILT', pulse=1500, frequency=50))
        relay.log('Servo safety: ARMED=0 ESTOP=0')
        relay.command_safety(dict(action='ENABLE'))
        with self.assertRaises(ValueError): relay.command_servo(dict(axis='TILT', pulse=1500, frequency=50))
        relay.write_commands(lambda data: len(data))
        relay.log('Servo safety: ARMED=1 ESTOP=0')
        relay.command_servo(dict(axis='TILT', pulse=1500, frequency=50))

    def test_estop_has_priority_cancels_pwm_and_cannot_be_bypassed(self):
        relay = self.ready()
        relay.log('Servo safety: ARMED=1 ESTOP=0')
        relay.command_servo(dict(axis='TILT', pulse=1700, frequency=50))
        relay.commands.put_nowait(b'RANGE 8 2000\n')
        relay.command_safety(dict(action='ESTOP'))
        with self.assertRaises(ValueError): relay.command_servo(dict(axis='TILT', pulse=1500, frequency=50))
        with self.assertRaises(ValueError): relay.command_safety(dict(action='ENABLE'))
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVOS ESTOP\n'])
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'cancelled')
        relay.log('Servo safety: ARMED=0 ESTOP=1')
        self.assertEqual(relay.snapshot()['safety_command']['state'], 'applied')
        with self.assertRaises(ValueError): relay.command_safety(dict(action='ENABLE'))
        relay.command_safety(dict(action='CLEAR'))
        relay.write_commands(lambda data: len(data))
        relay.log('Servo safety: ARMED=0 ESTOP=0')
        with self.assertRaises(ValueError): relay.command_servo(dict(axis='TILT', pulse=1500, frequency=50))

    def test_stop_does_not_require_fresh_sensor_telemetry(self):
        relay = self.ready()
        relay.samples[-1]['received_at'] -= 30
        relay.command_safety(dict(action='DISABLE'))
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVOS DISABLE\n'])
        relay.safety_command['queued_at'] -= 6
        self.assertEqual(relay.snapshot()['safety_command']['state'], 'timeout')
        self.assertIn('unconfirmed', relay.snapshot()['safety_command']['message'])
