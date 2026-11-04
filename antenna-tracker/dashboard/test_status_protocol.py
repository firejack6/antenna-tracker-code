"""ATS1 status decode and /api/config smoke tests."""
import struct
import time
import unittest
import zlib
from types import SimpleNamespace
from status_protocol import (
    MAGIC_STATUS, STATUS_SIZE, STATUS_SIZE_SCHEDULE, STATUS_SIZE_BREAKAWAY, STATUS_SIZE_LEGACY, decode_status)
from relay import Relay, Handler
from adc_stream import Stream


class StatusProtocolTests(unittest.TestCase):
    def test_zero_payload_decodes_to_telemetry_keys(self):
        payload = bytes(STATUS_SIZE)
        frame = decode_status(payload)
        self.assertEqual(frame['device_ms'], 0)
        self.assertIn('PAN', frame['servos'])
        self.assertIn('TILT', frame['servo_motion'])
        self.assertIn('effective_config', frame)
        self.assertEqual(frame['effective_config']['wifi_ap'], 0)
        self.assertEqual(frame['effective_config']['adc_stream'], 0)
        self.assertEqual(frame['effective_config']['pan_breakaway_us'], 0)
        self.assertEqual(frame['effective_config']['pan_kp_near'], 0)
        self.assertEqual(frame['effective_config']['pan_fb'], 0)
        self.assertEqual(STATUS_SIZE, 964)

    def test_schedule_payload_decodes_without_pan_fb(self):
        self.assertEqual(STATUS_SIZE_SCHEDULE, 960)
        frame = decode_status(bytes(STATUS_SIZE_SCHEDULE))
        self.assertEqual(frame['effective_config']['pan_kp_near'], 0)
        self.assertIsNone(frame['effective_config']['pan_fb'])

    def test_breakaway_payload_decodes_without_schedule(self):
        self.assertEqual(STATUS_SIZE_BREAKAWAY, 940)
        frame = decode_status(bytes(STATUS_SIZE_BREAKAWAY))
        self.assertEqual(frame['effective_config']['pan_breakaway_us'], 0)
        self.assertIsNone(frame['effective_config']['pan_kp_near'])

    def test_legacy_payload_decodes_without_breakaway(self):
        self.assertEqual(STATUS_SIZE_LEGACY, 932)
        frame = decode_status(bytes(STATUS_SIZE_LEGACY))
        self.assertIsNone(frame['effective_config']['pan_breakaway_us'])
        self.assertIsNone(frame['effective_config']['pan_breakaway_ms'])
        self.assertEqual(frame['effective_config']['adc_stream'], 0)

    def test_stream_delivers_status_callback(self):
        seen = []
        payload = bytes(STATUS_SIZE)
        packet = MAGIC_STATUS + struct.pack('<H', STATUS_SIZE) + payload + struct.pack('<I', zlib.crc32(payload))
        stream = Stream(lambda line: None, lambda *a: None, lambda: None, seen.append)
        stream.feed(packet)
        self.assertEqual(seen, [payload])

    def test_relay_status_updates_safety_and_config_api(self):
        relay = Relay()
        payload = bytearray(STATUS_SIZE)
        # device_ms at offset 0, armed/estop are the last two int32s of the header (offset 120)
        struct.pack_into('<I', payload, 0, 1234)
        struct.pack_into('<ii', payload, 120, 1, 0)
        relay.status_frame(bytes(payload))
        self.assertEqual(relay.servo_safety['armed'], 1)
        self.assertEqual(relay.telemetry['device_ms'], 1234)
        config = relay.effective_config()
        self.assertIn('board', config)
        self.assertIn('sources', config)
        body = {}
        handler = SimpleNamespace(
            local_request=lambda: True,
            reply=lambda data, code=200: body.update(data=data, code=code),
            path='/api/config',
            headers={},
            server=SimpleNamespace(relay=relay),
        )
        # Exercise Handler.do_GET path for /api/config via relay helper only.
        self.assertEqual(relay.effective_config()['sources']['browser'].split()[0], 'channel-scaling.js')


if __name__ == '__main__':
    unittest.main()
