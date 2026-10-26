import time
import unittest
from relay import Relay, Parser

class TiltCalibrationTests(unittest.TestCase):
    def ready(self):
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), tilt_config=dict(sweep=0)))
        relay.log('Servo safety: ARMED=0 ESTOP=0')
        return relay

    def test_settings_and_zero_do_not_require_arming(self):
        relay = self.ready()
        relay.command_tilt(dict(action='configure', vmin=.01, vmax=3.2, zero=180, amin=-45, amax=90))
        self.assertEqual(relay.commands.get_nowait(), b'TILT CONFIG 0.01 3.2 180 -45 90\n')
        relay.command_tilt(dict(action='zero'))
        self.assertEqual(relay.commands.get_nowait(), b'TILT ZERO\n')
        self.assertTrue(relay.servo_inhibit)
        with self.assertRaises(ValueError): relay.command_tilt(dict(action='configure', vmin=3.3, vmax=.01, zero=0, amin=0, amax=360))

    def test_sweep_requires_arming_and_bounds_speed(self):
        relay = self.ready()
        with self.assertRaises(ValueError): relay.command_tilt(dict(action='sweep_start', speed=5, direction=1))
        relay.log('Servo safety: ARMED=1 ESTOP=0')
        for speed in (0, 101, float('nan')):
            with self.assertRaises(ValueError): relay.command_tilt(dict(action='sweep_start', speed=speed, direction=1))
        relay.command_tilt(dict(action='sweep_start', speed=2, direction=-1))
        self.assertEqual(relay.commands.get_nowait(), b'TILT SWEEP START 2 -1 300\n')
        relay.command_tilt(dict(action='sweep_start', speed=2, direction=1, cap=60))
        self.assertEqual(relay.commands.get_nowait(), b'TILT SWEEP START 2 1 60\n')
        relay.command_tilt(dict(action='sweep_start', speed=2, direction=1, cap=1000))
        self.assertEqual(relay.commands.get_nowait(), b'TILT SWEEP START 2 1 1000\n')
        relay.command_tilt(dict(action='sweep_start', speed=2, direction=1, cap=300, polarity=-1))
        self.assertEqual(relay.commands.get_nowait(), b'TILT SWEEP START 2 1 300 -1\n')
        relay.command_tilt(dict(action='sweep_start', speed=2, direction=1, cap=300, minimum=60, rotations=3))
        self.assertEqual(relay.commands.get_nowait(), b'TILT SWEEP START 2 1 300 1 60 3\n')
        for extra in (dict(rotations=0), dict(rotations=1.5), dict(rotations=21), dict(minimum=-1), dict(minimum=301)):
            with self.assertRaises(ValueError):
                relay.command_tilt(dict(action='sweep_start', cap=300, **extra))
        with self.assertRaises(ValueError): relay.command_tilt(dict(action='sweep_start', polarity=0))
        with self.assertRaises(ValueError): relay.command_tilt(dict(action='sweep_start', speed=2, direction=1, cap=1001))
        relay.samples[-1]['received_at'] -= 10
        relay.command_tilt(dict(action='sweep_stop'))
        self.assertEqual(relay.priority_commands.get_nowait(), b'TILT SWEEP STOP\n')

    def test_range_can_only_be_applied_after_completion(self):
        relay = self.ready()
        with self.assertRaises(ValueError): relay.command_tilt(dict(action='sweep_apply'))
        relay.samples[-1]['tilt_config']['sweep'] = 2
        relay.command_tilt(dict(action='sweep_apply'))
        self.assertEqual(relay.commands.get_nowait(), b'TILT SWEEP APPLY\n')

    def test_parse_calibration_and_missing_sweep_extrema(self):
        frames = []; parser = Parser(frames.append)
        parser.line('Time ms: 10')
        parser.line('Tilt config: VMIN=0.004 VMAX=3.3 ZERO=180 AMIN=-45 AMAX=45 VOLTS=1.652 SWEEP=0 SMIN=nan SMAX=nan PROGRESS=0')
        parser.flush()
        self.assertEqual(frames[0]['tilt_config']['zero'], 180)
        self.assertIsNone(frames[0]['tilt_config']['smin'])
