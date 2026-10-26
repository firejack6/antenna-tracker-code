import math
import io
import json
from types import SimpleNamespace
from unittest.mock import Mock
import time
import unittest
from relay import Parser, Relay, Handler
import test_servo_ack


class ServoMotionTests(unittest.TestCase):
    def test_pan_calibration_is_config_only_and_validated(self):
        frames=[]; parser=Parser(frames.append)
        parser.line('Time ms: 100')
        parser.line('Pan config: NEUTRAL=1500 POLARITY=1 VMIN=0.004 VMAX=3.3 SPAN=360 ZERO=0 AMIN=0 AMAX=360')
        parser.flush()
        relay=Relay(); relay.status='connected'
        relay.sample(dict(received_at=time.time(),pan_config=frames[0]['pan_config']))
        config=dict(action='configure',neutral=1510,polarity=-1,vmin=.004,vmax=3.3,span=360,zero=180,amin=-90,amax=90)
        relay.command_pan(config)
        self.assertEqual(relay.commands.get_nowait(),b'PAN CONFIG 1510 -1 0.004 3.3 360 180 -90 90\n')
        for key,value in [('polarity',0),('vmax',.01),('span',0),('neutral',499),('amin',91),('zero',float('nan'))]:
            with self.assertRaises(ValueError): relay.command_pan(dict(config,**{key:value}))
        for action in ('zero','save'):
            relay.command_pan(dict(action=action))
            self.assertEqual(relay.commands.get_nowait(),f'PAN {action.upper()}\n'.encode())
        relay.command_pan(dict(action='cr_configure', ff=.5, rise=80, fall=200, search=5, search_max=20, brake=.08))
        self.assertEqual(relay.commands.get_nowait(), b'PAN CR CONFIG 0.5 80 200 5 20 0.08\n')
        with self.assertRaises(ValueError):
            relay.command_pan(dict(action='cr_configure', ff=.5, rise=0, fall=200, search=5, search_max=20, brake=.08))
        relay.status='disconnected'
        with self.assertRaises(ValueError): relay.command_pan(config)

    def test_direct_manual_uses_separate_raw_command(self):
        relay = test_servo_ack.ServoAcknowledgementTests().ready()
        relay.samples[-1]['servos']['TILT']['mode'] = 1
        relay.command_servo(dict(axis='TILT', pulse=1560, frequency=50, continuous=True, manual=True, speed_limit=30))
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVO RAW TILT 1560 50\n'])
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'sent')
        relay.log('Servo ack: TILT PULSE=1560 FREQ=50 ENABLE=1 TARGET=1560')
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'applied')

    def test_continuous_without_manual_uses_cr_and_speed_limit(self):
        relay = test_servo_ack.ServoAcknowledgementTests().ready()
        relay.samples[-1]['servos']['TILT']['mode'] = 1
        relay.command_servo(dict(axis='TILT', pulse=1600, frequency=50, continuous=True, speed_limit=30))
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVO CR TILT 1600 50 30\n'])

    def test_imu_mapping_and_telemetry(self):
        frames=[]; parser=Parser(frames.append)
        parser.line('Time ms: 100')
        parser.line('Tilt IMU: ANGLE=-125 SPEED=0 RAW=-125 ZERO=0 AXIS=1 READY=0 ACTIVE=1 AMIN=0 AMAX=110 US=100000')
        parser.flush()
        self.assertEqual(frames[0]['tilt_imu']['angle'],-125)
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), tilt_imu=frames[0]['tilt_imu']))
        relay.command_tilt_imu(dict(action='configure',axis=1,zero=0,amin=-140,amax=-30))
        self.assertEqual(relay.commands.get_nowait(), b'TILT IMU CONFIG 1 0 -140 -30\n')
        for axis, low, high in ((2,0,110),(1,0,0),(1,0,181),(True,0,110)):
            with self.assertRaises(ValueError):
                relay.command_tilt_imu(dict(action='configure',axis=axis,zero=0,amin=low,amax=high))
        relay.command_tilt_imu(dict(action='zero'))
        self.assertEqual(relay.commands.get_nowait(), b'TILT IMU ZERO\n')

    def test_position_commands_and_pid_validation(self):
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), servo_position={'TILT': {'kp': .2}},
            servo_motion={'TILT': {'limit': 30}}, tilt_config={'amin': -20, 'amax': 90}))
        gains = dict(axis='TILT', kp=.2, ki=0, kd=.02, ilimit=20, cap=60, tolerance=1)
        relay.command_servo_position(gains, gains=True)
        self.assertEqual(relay.commands.get_nowait(), b'SERVO PID TILT 0.2 0 0.02 20 60 1\n')
        for key, value in [('kp', float('nan')), ('ki', -1), ('kd', True), ('cap', 1001), ('tolerance', 0)]:
            with self.assertRaises(ValueError): relay.command_servo_position(dict(gains, **{key:value}), gains=True)
        with self.assertRaises(ValueError): relay.command_servo_position(dict(axis='TILT', angle=30))
        relay.log('Servo safety: ARMED=1 ESTOP=0')
        relay.command_servo_position(dict(axis='TILT', angle=30))
        self.assertEqual(relay.commands.get_nowait(), b'SERVO POSITION TILT 30\n')
        for angle in (-21, 91, float('nan'), True):
            with self.assertRaises(ValueError): relay.command_servo_position(dict(axis='TILT', angle=angle))
        relay.samples[-1]['servo_motion']['TILT']['limit'] = 0
        relay.command_servo_position(dict(axis='TILT', angle=30))
        self.assertEqual(relay.commands.get_nowait(), b'SERVO POSITION TILT 30\n')

    def test_deadband_http_request_replies_after_queuing(self):
        payload = dict(axis='TILT', dbplus=60, dbminus=60)
        body = json.dumps(payload).encode()
        handler = SimpleNamespace(local_request=lambda: True,
            headers={'Content-Type':'application/json', 'Content-Length':str(len(body))},
            rfile=io.BytesIO(body), path='/api/servo-deadband',
            server=SimpleNamespace(relay=Mock()), reply=Mock())
        Handler.do_POST(handler)
        handler.server.relay.command_servo_position.assert_called_once_with(payload, gains='deadband')
        handler.reply.assert_called_once_with({'ok':True})

    def test_ramp_checkbox_command(self):
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), servo_position={'TILT': {'ramp':1}}))
        for enabled in (False, True):
            relay.command_servo_position(dict(axis='TILT', enabled=enabled), gains='ramp')
            self.assertEqual(relay.commands.get_nowait(), f'SERVO RAMP TILT {int(enabled)}\n'.encode())
        with self.assertRaises(ValueError):
            relay.command_servo_position(dict(axis='TILT', enabled=0), gains='ramp')
        relay.command_servo_position(dict(axis='TILT', enabled=True, rate=12.5), gains='ramp')
        self.assertEqual(relay.commands.get_nowait(), b'SERVO RAMP TILT 1 12.5\n')
        for rate in (0, -1, 361, True, float('nan')):
            with self.assertRaises(ValueError):
                relay.command_servo_position(dict(axis='TILT', enabled=True, rate=rate), gains='ramp')

    def test_deadband_zero_and_validation(self):
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), servo_position={'TILT': {}}))
        relay.command_servo_position(dict(axis='TILT', dbplus=0, dbminus=60), gains='deadband')
        self.assertEqual(relay.commands.get_nowait(), b'SERVO DEADBAND TILT 0 60\n')
        for value in (-1, 1001, float('nan'), True, None):
            with self.assertRaises(ValueError):
                relay.command_servo_position(dict(axis='TILT', dbplus=value, dbminus=0), gains='deadband')

    def test_position_telemetry_includes_runtime_gains(self):
        frames=[]; parser=Parser(frames.append)
        parser.line('Time ms: 100')
        parser.line('Position TILT: TARGET=45 ACTIVE=0 KP=0.2 KI=0 KD=0.02 ILIMIT=20 CAP=60 TOLERANCE=1 DBPLUS=42 DBMINUS=60')
        parser.flush()
        self.assertEqual(frames[0]['servo_position']['TILT']['target'],45)
        self.assertEqual(frames[0]['servo_position']['TILT']['kd'],.02)
        self.assertEqual(frames[0]['servo_position']['TILT']['dbplus'],42)

    def test_overspeed_toggle_requires_fresh_supported_telemetry(self):
        relay = Relay(); relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), servo_motion={'TILT': {'osfault': 1}}))
        relay.command_servo_overspeed(dict(axis='TILT', enabled=False))
        self.assertEqual(relay.commands.get_nowait(), b'SERVO OVERSPEED TILT 0\n')
        relay.command_servo_overspeed(dict(axis='TILT', enabled=True))
        self.assertEqual(relay.commands.get_nowait(), b'SERVO OVERSPEED TILT 1\n')
        self.assertTrue(relay.servo_inhibit)
        for data in (dict(axis='S3', enabled=False), dict(axis='TILT', enabled=0), dict(axis='PAN', enabled=False)):
            with self.assertRaises(ValueError): relay.command_servo_overspeed(data)
        relay.samples[-1]['received_at'] -= 10
        with self.assertRaises(ValueError): relay.command_servo_overspeed(dict(axis='TILT', enabled=False))
    def test_ramp_ack_confirms_target_not_intermediate_output(self):
        relay = test_servo_ack.ServoAcknowledgementTests().ready()
        relay.command_servo(dict(axis='TILT', pulse=2400, frequency=50))
        relay.write_commands(lambda data: len(data))
        relay.log('Servo ack: TILT PULSE=1500 FREQ=50 ENABLE=1 TARGET=2400')
        pending = relay.snapshot()['servo_commands']['TILT']
        self.assertEqual(pending['state'], 'applied')
        self.assertIn('ramping', pending['message'])

    def test_motion_nan_is_json_safe(self):
        frames = []
        parser = Parser(frames.append)
        parser.line('Time ms: 10')
        parser.line('Motion TILT: ANGLE=nan SPEED=nan LIMIT=30 TARGET=2400 MOVING=0 MINANGLE=0 MAXANGLE=360')
        parser.flush()
        self.assertIsNone(frames[0]['servo_motion']['TILT']['angle'])
    def test_pid_terms_and_missing_values_are_parsed(self):
        frames = []; parser = Parser(frames.append)
        parser.line('Time ms: 100')
        parser.line('PID TILT: SETPOINT=1 ERROR=-2 P=-0.08 I=0.02 D=0 FF=60.03 STARTUP=0 REQUEST=59.97 OUTPUT=60 ACTIVE=1')
        parser.line('PID PAN: SETPOINT=nan ERROR=nan P=0 I=0 D=0 FF=0 STARTUP=0 REQUEST=0 OUTPUT=0 ACTIVE=0')
        parser.flush()
        self.assertEqual(frames[0]['servo_pid']['TILT']['output'], 60)
        self.assertAlmostEqual(frames[0]['servo_pid']['TILT']['p'], -.08)
        self.assertIsNone(frames[0]['servo_pid']['PAN']['error'])

    def test_old_position_requests_are_rejected_for_continuous_servos(self):
        relay = test_servo_ack.ServoAcknowledgementTests().ready()
        relay.samples[-1]['servos']['TILT']['mode'] = 1
        with self.assertRaises(ValueError): relay.command_servo(dict(axis='TILT', pulse=2400, frequency=50))
        relay.command_servo(dict(axis='TILT', pulse=1600, frequency=50, continuous=True))
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVO CR TILT 1600 50\n'])
        relay.command_servo(dict(axis='TILT', off=True))
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes[-1], b'SERVO TILT OFF\n')

    def test_speed_setting_does_not_arm_outputs(self):
        relay = Relay()
        relay.status = 'connected'
        relay.sample(dict(received_at=time.time(), servo_motion={'PAN': {'limit': 30}}))
        relay.command_servo_speed(dict(axis='PAN', speed=12.5))
        self.assertEqual(relay.commands.get_nowait(), b'SERVO SPEED PAN 12.5\n')
        self.assertTrue(relay.servo_inhibit)
        for value in (-1, 361, math.nan, True):
            with self.assertRaises(ValueError): relay.command_servo_speed(dict(axis='PAN', speed=value))

    def test_command_applies_typed_speed_limit_atomically(self):
        relay = test_servo_ack.ServoAcknowledgementTests().ready()
        relay.samples[-1]['servos']['TILT']['mode'] = 1
        relay.command_servo(dict(axis='TILT', pulse=1600, frequency=50, continuous=True, speed_limit=12.5))
        writes = []
        relay.write_commands(lambda data: writes.append(data) or len(data))
        self.assertEqual(writes, [b'SERVO CR TILT 1600 50 12.5\n'])
        relay.log('Servo ack: TILT PULSE=1500 FREQ=50 ENABLE=1 TARGET=1600')
        self.assertEqual(relay.snapshot()['servo_commands']['TILT']['state'], 'applied')
