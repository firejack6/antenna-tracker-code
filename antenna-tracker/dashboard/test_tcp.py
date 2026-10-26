import socket
import threading
import unittest
from unittest.mock import patch, Mock

from relay import Relay
from test_relay import wait_for
from test_adc_stream import packet, record


class TcpTests(unittest.TestCase):
    def test_silent_socket_is_reconnected_instead_of_remaining_connected_forever(self):
        relay = Relay()
        connection = Mock()
        context = Mock()
        context.__enter__ = Mock(return_value=connection)
        context.__exit__ = Mock(return_value=False)
        with patch('relay.socket.create_connection', return_value=context), patch('relay.time.monotonic', return_value=0) as clock:
            def silent(size):
                clock.return_value = 11
                raise socket.timeout()
            connection.recv.side_effect = silent
            with self.assertRaisesRegex(RuntimeError, 'No TCP telemetry for 10 seconds'):
                relay._tcp_once('127.0.0.1:9000', Mock())
        connection.setsockopt.assert_any_call(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)

    def test_suppressed_raw_logging_still_processes_safety_status(self):
        relay = Relay()
        relay.log('Servo safety: ARMED=0 ESTOP=1', capture=False)
        state = relay.snapshot()
        self.assertFalse(state['logs'])
        self.assertEqual(state['servo_safety']['estop'], 1)
        self.assertTrue(state['servo_inhibit'])
        relay.log('TCP connection failed')
        self.assertEqual(relay.snapshot()['logs'][0]['text'], 'TCP connection failed')

    def test_successful_tcp_connection_retries_indefinitely_every_five_seconds(self):
        relay = Relay()
        lines = Mock()
        lines.pending = bytearray()
        attempts = []
        def connection(endpoint, stream):
            attempts.append(endpoint)
            if len(attempts) == 1:
                relay.remote_connected_at = 1.0
                relay.commands.put(b'ADC CHANNEL 3\n')
                stream.pending.extend(b'partial')
            else:
                self.assertTrue(relay.commands.empty())
                self.assertFalse(stream.pending)
            if len(attempts) == 7: relay.stop.set()
            raise RuntimeError('Connection dropped' if len(attempts) == 1 else 'ESP offline')
        with patch.object(relay, '_tcp_once', side_effect=connection), patch.object(relay.stop, 'wait', return_value=False) as wait:
            relay._remote('', '127.0.0.1:9000', 115200, lines, tcp=True)
        self.assertEqual(len(attempts), 7)
        self.assertEqual([call.args for call in wait.call_args_list], [(5,)] * 6)
        self.assertIn('reconnecting in 5s', relay.snapshot()['message'])

    def test_socket_stream_decodes_fragmented_binary_and_sends_adc_command(self):
        relay = Relay()
        received = []
        errors = []
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(4)
        def board():
            try:
                with listener.accept()[0] as connection:
                    connection.settimeout(4)
                    data = (b'Time ms: 1\nADC mode: CHANNEL=-1 SPI=16000000\n\n' +
                            packet([record(1, 1000, 17), record(2, 1100, 4095)]))
                    for position in range(0, len(data), 7):
                        connection.sendall(data[position:position + 7])
                    command = bytearray()
                    while b'\n' not in command: command.extend(connection.recv(128))
                    received.append(bytes(command))
                    while connection.recv(128): pass
            except Exception as error:
                errors.append(error)
        worker = threading.Thread(target=board, daemon=True)
        worker.start()
        try:
            relay.connect(dict(mode='tcp', port=f'127.0.0.1:{listener.getsockname()[1]}'))
            wait_for(lambda: relay.snapshot()['acquisition']['raw_scans'] == 2)
            state = relay.snapshot()
            self.assertEqual(state['latest']['adc'], [4095] * 16)
            self.assertEqual(state['acquisition']['corrupt_packets'], 0)
            relay.commands.put(b'ADC CHANNEL 3\n')
            wait_for(lambda: bool(received))
            self.assertEqual(received, [b'ADC CHANNEL 3\n'])
        finally:
            relay.disconnect()
            worker.join(4)
            listener.close()
        self.assertFalse(worker.is_alive())
        self.assertFalse(errors, errors)

    def test_tcp_retry_discards_partial_packet_and_queued_controls(self):
        relay = Relay()
        attempts = []
        def connection(endpoint, lines):
            attempts.append(endpoint)
            if len(attempts) == 1:
                relay.commands.put(b'SERVO TILT 1500 50\n')
                lines.pending.extend(b'\x00ATB2')
                raise RuntimeError('Network interruption')
            self.assertTrue(relay.commands.empty())
            self.assertFalse(lines.pending)
            self.assertTrue(relay.servo_inhibit)
            relay.set_status('connected', 'TCP test')
            relay.stop.wait(4)
        with patch.object(relay, '_tcp_once', side_effect=connection), patch('relay.REMOTE_RETRY_DELAYS', (.01,)):
            try:
                relay.connect(dict(mode='tcp', port='127.0.0.1:9000'))
                wait_for(lambda: relay.snapshot()['status'] == 'connected')
                self.assertEqual(len(attempts), 2)
            finally: relay.disconnect()

    def test_invalid_tcp_endpoint_is_rejected(self):
        relay = Relay()
        for endpoint in ('', '192.168.20.1', ':9000', 'host:0', 'host:65536', 'host:abc'):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                relay.connect(dict(mode='tcp', port=endpoint))
