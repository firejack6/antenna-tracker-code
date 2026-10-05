import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from relay import Handler, Lines, Parser, Relay, ThreadingHTTPServer, remote_command


def wait_for(test, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if test():
            return
        time.sleep(.03)
    raise AssertionError("Condition did not become true")


class ParserTests(unittest.TestCase):
    def test_servo_telemetry_is_not_reused_between_frames(self):
        frames = []
        parser = Parser(frames.append)
        for line in ['Time ms: 1', 'Servo PAN: GPIO=1 PMIN=1000 PCENTER=1500 PMAX=2000 FMIN=50 FCENTER=50 FMAX=50 PULSE=1750 FREQ=50 ENABLE=1 READY=1', '',
                     'Time ms: 2', 'Servo PAN: PULSE=1500', '']:
            parser.line(line)
        self.assertEqual(frames[0]['servos']['PAN']['pulse'], 1750)
        self.assertEqual(frames[1]['servos'], {})

    def test_gpio_states_and_missing_frame(self):
        frames = []
        parser = Parser(frames.append)
        for line in ['Time ms: 1', 'GPIO states: GPIO46=1 GPIO4=0 GPIO13=1 GPIO14=0', '',
                     'Time ms: 2', 'GPIO states: GPIO4=invalid', '']:
            parser.line(line)
        self.assertEqual(frames[0]['gpio'], {'46': 1, '4': 0, '13': 1, '14': 0})
        self.assertEqual(frames[1]['gpio'], {str(pin): None for pin in (46, 4, 13, 14)})

    def test_chunks_errors_and_missing_values_do_not_reuse_old_frame(self):
        frames = []
        parser = Parser(frames.append)
        lines = Lines(parser.line)
        data = ("Startup banner\r\nTime ms: 200\r\nADC raw (0..4095): " +
                " ".join(f"CH{i}={i*100}" for i in range(16)) +
                "\r\nAccel g (x,y,z): -0.1, 2, 1e-3\r\nGyro dps (x,y,z): 1, 2, 3\r\n"
                "Mag uT (x,y,z): 4, 5, 6\r\n\r\n\x1b[32mTime ms: 400\x1b[0m\r\n"
                "ADC raw (0..4095): CH0=ERR CH1=4095 CH2=9999\r\nBMI323 read failed\r\n"
                "Mag uT (x,y,z): nan, 2, 3\r\n\r\n").encode()
        for i in range(0, len(data), 7):
            lines.feed(data[i:i+7])
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0]["adc"], [i*100 for i in range(16)])
        self.assertEqual(frames[0]["accel"], [-.1, 2, .001])
        self.assertEqual(frames[1]["adc"][:3], [None, 4095, None])
        self.assertIsNone(frames[1]["accel"])
        self.assertIsNone(frames[1]["mag"])
        self.assertEqual(len(frames[1]["errors"]), 2)
        json.dumps(frames, allow_nan=False)

    def test_next_timestamp_flushes_partial_frame_and_reboot(self):
        frames = []
        parser = Parser(frames.append)
        for line in ["Time ms: 4294967290", "Time ms: 2", "", ""]:
            parser.line(line)
        self.assertEqual([s["device_ms"] for s in frames], [4294967290, 2])

    def test_unterminated_input_is_bounded(self):
        lines = Lines(lambda _: None)
        lines.feed(b"x" * 20000)
        self.assertEqual(lines.pending, "")


class LifecycleTests(unittest.TestCase):
    def test_remote_retry_recovers_and_does_not_replay_commands(self):
        relay = Relay()
        attempts = []
        def bridge(agent, port, baud, lines):
            attempts.append(port)
            if len(attempts) == 1:
                relay.commands.put(b'SERVO TILT 1500 50\n')
                relay.servo_command_status['TILT'] = dict(state='sent')
                lines.pending.extend(b'\x00ATB2\x20')
                raise RuntimeError('Temporary bridge close')
            self.assertEqual(bytes(lines.pending), b'')
            self.assertTrue(relay.commands.empty())
            self.assertEqual(relay.servo_command_status['TILT']['state'], 'cancelled')
            self.assertTrue(relay.servo_inhibit)
            relay.set_status('connected', 'Recovered')
            lines.feed(b'Time ms: 123\nADC raw (0..4095): CH3=100\n\n')
            relay.stop.wait(3)
        with patch.object(relay, '_remote_once', side_effect=bridge), patch('relay.REMOTE_RETRY_DELAYS', (.01, .02)):
            try:
                relay.connect(dict(mode='remote', port='COM8'))
                wait_for(lambda: bool(relay.snapshot()['latest']))
                self.assertEqual(attempts, ['COM8', 'COM8'])
                self.assertEqual(relay.snapshot()['latest']['adc'][3], 100)
            finally:
                relay.disconnect()

    def test_remote_retries_exhaust_and_disconnect_interrupts_backoff(self):
        relay = Relay()
        with patch.object(relay, '_remote_once', side_effect=RuntimeError('Port busy')), patch('relay.REMOTE_RETRY_DELAYS', (.01, .02)):
            try:
                relay.connect(dict(mode='remote', port='COM8'))
                wait_for(lambda: relay.snapshot()['status'] == 'error')
                self.assertIn('exhausted', relay.snapshot()['message'])
                self.assertIn('Port busy', relay.snapshot()['message'])
            finally:
                relay.disconnect()
        with patch.object(relay, '_remote_once', side_effect=RuntimeError('Port busy')), patch('relay.REMOTE_RETRY_DELAYS', (30,)):
            relay.connect(dict(mode='remote', port='COM8'))
            wait_for(lambda: 'reconnecting' in relay.snapshot()['message'])
            started = time.monotonic()
            relay.disconnect()
            self.assertLess(time.monotonic() - started, 1)

    def test_adc_single_channel_and_restore(self):
        relay = Relay()
        try:
            with self.assertRaises(ValueError): relay.command_adc_channel({'channel': 3})
            relay.connect({'mode': 'demo'})
            wait_for(lambda: bool(relay.snapshot()['latest']))
            for channel in (-2, 16, True, '3'):
                with self.assertRaises(ValueError): relay.command_adc_channel({'channel': channel})
            relay.command_adc_channel({'channel': 3})
            wait_for(lambda: relay.snapshot()['latest']['adc_mode']['channel'] == 3)
            frame = relay.snapshot()['latest']
            self.assertEqual(frame['adc_mode']['spi'], 16000000)
            self.assertIsNotNone(frame['adc'][3])
            self.assertTrue(all(value is None for i, value in enumerate(frame['adc']) if i != 3))
            relay.command_adc_channel({'channel': -1})
            wait_for(lambda: relay.snapshot()['latest']['adc_mode']['channel'] == -1)
            self.assertTrue(all(value is not None for value in relay.snapshot()['latest']['adc']))
        finally:
            relay.disconnect()

    def test_servo_demo_commands_validation_and_disconnect(self):
        relay = Relay()
        try:
            with self.assertRaises(ValueError):
                relay.command_servo({'axis': 'PAN', 'pulse': 1500, 'frequency': 50})
            relay.connect({'mode': 'demo'})
            wait_for(lambda: bool(relay.snapshot()['samples']))
            self.assertEqual(relay.snapshot()['latest']['servos']['PAN']['enable'], 0)
            relay.command_safety({'action': 'ENABLE'})
            wait_for(lambda: relay.snapshot()['safety_command']['state'] == 'applied')
            for bad in [{'axis': 'OTHER'}, {'axis': 'PAN', 'pulse': 499, 'frequency': 50},
                        {'axis': 'PAN', 'pulse': 1500, 'frequency': 51},
                        {'axis': 'PAN', 'pulse': True, 'frequency': 50}]:
                with self.assertRaises(ValueError): relay.command_servo(bad)
            relay.command_servo({'axis': 'PAN', 'pulse': 1750, 'frequency': 50})
            wait_for(lambda: relay.snapshot()['latest']['servos']['PAN']['pulse'] == 1750)
            self.assertEqual(relay.snapshot()['latest']['servos']['PAN']['enable'], 1)
            self.assertEqual(relay.snapshot()['latest']['servos']['TILT']['enable'], 0)
            relay.command_servo({'axis': 'PAN', 'off': True})
            wait_for(lambda: relay.snapshot()['latest']['servos']['PAN']['enable'] == 0)
            with relay.lock:
                relay.samples[-1]['received_at'] = time.time() - 10
            with self.assertRaises(ValueError):
                relay.command_servo({'axis': 'PAN', 'pulse': 1500, 'frequency': 50})
            relay.disconnect()
            self.assertTrue(relay.commands.empty())
        finally:
            relay.disconnect()

    def test_remote_bridge_has_required_serial_settings(self):
        with patch("relay.pio_command", return_value=["pio"]):
            cmd = remote_command("desktop-o1gdd79", "COM8", 115200, "bridge-dir")
        # --sock bypasses PlatformIO's normal project/default option filling.
        self.assertEqual(cmd[cmd.index("--parity") + 1], "N")
        self.assertEqual(cmd[cmd.index("--baud") + 1], "115200")
        self.assertEqual(cmd[cmd.index("--dtr") + 1], "1")
        self.assertEqual(cmd[cmd.index("--rts") + 1], "0")

    def test_demo_disconnect_reconnect_and_history_cursor(self):
        relay = Relay()
        try:
            relay.connect({"mode": "demo"})
            wait_for(lambda: len(relay.snapshot()["samples"]) >= 2)
            first = relay.snapshot()
            self.assertEqual(first["status"], "connected")
            self.assertEqual(relay.snapshot(first["cursor"])["samples"], [])
            relay.disconnect()
            count = len(relay.snapshot()["samples"])
            time.sleep(.25)
            self.assertEqual(len(relay.snapshot()["samples"]), count)
            relay.connect({"mode": "demo"})
            wait_for(lambda: bool(relay.snapshot()["samples"]))
            self.assertGreater(relay.snapshot()["session"], first["session"])
        finally:
            relay.disconnect()

    def test_remote_bridge_subprocess_reads_and_releases_socket(self):
        # Exercise the real subprocess + socket path without a cloud account.
        script = '''import socket,sys,time
from pathlib import Path
s=socket.socket();s.bind(('127.0.0.1',0));s.listen()
Path(sys.argv[1],'sock').write_text('socket://localhost:'+str(s.getsockname()[1]))
c,_=s.accept()
c.sendall(b'Time ms: 42\\nADC raw (0..4095): CH0=123\\nServo PAN: GPIO=1 PMIN=1000 PCENTER=1500 PMAX=2000 FMIN=50 FCENTER=50 FMAX=50 PULSE=1500 FREQ=50 ENABLE=0 READY=1\\n\\n')
buffer=b''
while True:
    chunk=c.recv(1024)
    if not chunk: break
    buffer+=chunk
    if b'\\n' in buffer:
        command,buffer=buffer.split(b'\\n',1)
        if command == b'SERVO PAN 1750 50':
            c.sendall(b'Time ms: 43\\nServo PAN: GPIO=1 PMIN=1000 PCENTER=1500 PMAX=2000 FMIN=50 FCENTER=50 FMAX=50 PULSE=1750 FREQ=50 ENABLE=1 READY=1\\n\\n')
c.close();s.close()
'''
        relay = Relay()
        with tempfile.TemporaryDirectory() as temp:
            script_path = Path(temp) / "bridge.py"
            script_path.write_text(script)
            with patch("relay.remote_command", side_effect=lambda a,p,b,d: [sys.executable, str(script_path), str(d)]):
                try:
                    relay.connect({"mode": "remote", "port": "COM42"})
                    wait_for(lambda: bool(relay.snapshot()["samples"]))
                    self.assertEqual(relay.snapshot()["samples"][0]["adc"][0], 123)
                    relay.log('Servo safety: ARMED=1 ESTOP=0')
                    relay.command_servo({'axis': 'PAN', 'pulse': 1750, 'frequency': 50})
                    wait_for(lambda: relay.snapshot()['latest']['servos']['PAN']['pulse'] == 1750)
                    relay.disconnect()
                    self.assertIsNone(relay.worker)
                finally:
                    relay.disconnect()

    def test_direct_serial_config_chunking_and_close(self):
        class FakeSerial:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.port = None
                self.closed = False
                self.writes = []
                self.data = bytearray(b'Time ms: 5\nAccel g (x,y,z): 1,2,3\nServo PAN: GPIO=1 PMIN=1000 PCENTER=1500 PMAX=2000 FMIN=50 FCENTER=50 FMAX=50 PULSE=1500 FREQ=50 ENABLE=0 READY=1\n\n')
            def write(self, command):
                self.writes.append(command)
                return len(command)
            @property
            def in_waiting(self):
                return min(3, len(self.data))
            def __enter__(self):
                self.asserted = self.port == "COM7" and self.dtr and not self.rts
                return self
            def __exit__(self, *_):
                self.closed = True
            def read(self, n):
                if not self.data:
                    time.sleep(.01)
                chunk = bytes(self.data[:n]); del self.data[:n]
                return chunk
        device = FakeSerial()
        relay = Relay()
        with patch("serial.Serial", return_value=device):
            try:
                relay.connect({"mode": "direct", "port": "COM7"})
                wait_for(lambda: bool(relay.snapshot()["samples"]))
                self.assertEqual(relay.snapshot()["latest"]["accel"], [1,2,3])
                self.assertTrue(device.asserted)
                relay.log('Servo safety: ARMED=1 ESTOP=0')
                relay.command_servo({'axis': 'PAN', 'pulse': 1600, 'frequency': 50})
                wait_for(lambda: bool(device.writes))
                self.assertEqual(device.writes, [b'SERVO PAN 1600 50\n'])
            finally:
                relay.disconnect()
        self.assertTrue(device.closed)

    def test_invalid_options_and_failed_port(self):
        relay = Relay()
        with self.assertRaises(ValueError):
            relay.connect({"mode": "remote"})
        with patch("serial.Serial", side_effect=OSError("Port busy")):
            relay.connect({"mode": "direct", "port": "COM7"})
            wait_for(lambda: relay.snapshot()["status"] == "error")
            self.assertIn("Port busy", relay.snapshot()["message"])
            relay.disconnect()


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.relay = Relay()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.relay.disconnect()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_static_api_and_origin_rejection(self):
        with urlopen(self.url) as response:
            self.assertIn(b"Sensor dashboard", response.read())
        request = Request(self.url + "/api/connect", data=b'{"mode":"demo"}', headers={"Content-Type":"application/json"})
        with urlopen(request) as response:
            self.assertTrue(json.load(response)["ok"])
        wait_for(lambda: bool(self.server.relay.snapshot()["samples"]))
        with urlopen(self.url + "/api/state?since=0") as response:
            self.assertEqual(json.load(response)["mode"], "demo")
        evil = Request(self.url + "/api/disconnect", data=b'{}', headers={"Content-Type":"application/json", "Origin":"https://example.com"})
        self.server.relay.command_safety({'action': 'ENABLE'})
        wait_for(lambda: self.server.relay.snapshot()['safety_command']['state'] == 'applied')
        servo = Request(self.url + '/api/servo', data=b'{"axis":"TILT","pulse":1600,"frequency":50}', headers={'Content-Type': 'application/json'})
        with urlopen(servo) as response:
            self.assertTrue(json.load(response)['ok'])
        wait_for(lambda: self.server.relay.snapshot()['latest']['servos']['TILT']['pulse'] == 1600)
        invalid_servo = Request(self.url + '/api/servo', data=b'{"axis":"TILT","pulse":499,"frequency":50}', headers={'Content-Type': 'application/json'})
        with self.assertRaises(HTTPError) as invalid:
            urlopen(invalid_servo)
        self.assertEqual(invalid.exception.code, 400)
        with self.assertRaises(HTTPError) as error:
            urlopen(evil)
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError):
            urlopen(self.url + "/../relay.py")


if __name__ == "__main__":
    unittest.main()
