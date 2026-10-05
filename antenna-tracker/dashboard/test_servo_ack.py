import time
import unittest
from relay import Relay


class ServoAcknowledgementTests(unittest.TestCase):
    def ready(self):
        relay = Relay()
        relay.status = 'connected'
        relay.log('Servo safety: ARMED=1 ESTOP=0')
        relay.sample(dict(received_at=time.time(), servos={'TILT': dict(ready=1, pmin=500, pmax=2500, fmin=50, fmax=50)}))
        return relay

    def test_command_is_not_confirmed_until_matching_board_ack(self):
        relay = self.ready()
        relay.command_servo(dict(axis='TILT', pulse=1700, frequency=50))
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'queued')
        relay.log('Servo ack: TILT PULSE=1700 FREQ=50 ENABLE=1')
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'queued')
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVO TILT 1700 50\n'])
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'sent')
        relay.log('Servo ack: TILT PULSE=1600 FREQ=50 ENABLE=1')
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'sent')
        relay.log('Servo ack: TILT PULSE=1700 FREQ=50 ENABLE=1')
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'applied')

    def test_unsent_commands_expire_and_are_not_sent_later(self):
        relay = self.ready()
        relay.command_servo(dict(axis='TILT', off=True))
        relay.servo_command_status['TILT']['queued_at'] -= 6
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'timeout')
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [])

    def test_serial_send_failure_is_reported(self):
        relay = self.ready()
        relay.command_servo(dict(axis='TILT', off=True))
        def fail(data): raise OSError('port closed')
        with self.assertRaises(OSError): relay.write_commands(fail)
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'error')
        self.assertIn('port closed', relay.snapshot()['servo_commands']['TILT']['message'])

    def test_fresh_adc_does_not_make_stale_servo_telemetry_fresh(self):
        relay = self.ready()
        relay.telemetry['received_at'] -= 10
        relay.binary_active = True
        relay.samples[-1] = dict(relay.samples[-1], received_at=time.time())
        with self.assertRaises(ValueError): relay.command_servo(dict(axis='TILT', off=True))
