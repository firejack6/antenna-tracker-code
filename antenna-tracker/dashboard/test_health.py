import unittest
from unittest.mock import patch

from relay import Relay, Parser
from test_adc_stream import record, packet


class HealthTests(unittest.TestCase):
    def test_tcp_timing_reports_socket_age_separately_from_adc_age(self):
        relay = Relay()
        relay.tcp_last_received = 100
        relay.tcp_max_receive_gap_ms = 1250.25
        relay.tcp_max_decode_ms = 3.21
        with patch('relay.time.monotonic', return_value=102):
            health = relay.snapshot()['acquisition']
        self.assertEqual(health['tcp_receive_age_ms'], 2000)
        self.assertEqual(health['tcp_max_receive_gap_ms'], 1250.2)
        self.assertEqual(health['tcp_max_decode_ms'], 3.2)
        self.assertIsNone(health['data_age_ms'])
    def test_recent_metrics_expire_and_age_keeps_growing(self):
        with patch('relay.time.monotonic', return_value=100):
            relay = Relay()
        with patch('relay.time.monotonic', return_value=101):
            records = [record(1, 100), record(3, 300)]
            wire = packet(records)
            relay.adc_batch(records, wire)
        with patch('relay.time.monotonic', return_value=102):
            health = relay.snapshot()['acquisition']
        self.assertEqual(health['data_age_ms'], 1000)
        self.assertEqual(health['recent_gaps'], 1)
        self.assertEqual(health['recent_gap_percent'], 33.33)
        self.assertEqual(health['received_hz_10s'], 1)
        self.assertEqual(health['adc_kbytes_s_10s'], round(len(wire) / 2 / 1000, 1))
        with patch('relay.time.monotonic', return_value=112):
            health = relay.snapshot()['acquisition']
        self.assertEqual(health['data_age_ms'], 11000)
        self.assertEqual(health['recent_gaps'], 0)
        self.assertEqual(health['received_hz_10s'], 0)
        self.assertEqual(health['sequence_gaps'], 1)

    def test_no_data_is_unknown_and_device_health_survives_binary_summary(self):
        relay = Relay()
        self.assertIsNone(relay.snapshot()['acquisition']['data_age_ms'])
        parser = Parser(relay.sample)
        parser.line('Time ms: 100')
        parser.line('Link health: QUEUED=128 CAPACITY=4096 STALLS=4 FAILED=1 MAXWRITE=500 CONNECTIONS=2')
        parser.line('')
        records = [record(1, 100000)]
        relay.adc_batch(records, packet(records))
        self.assertEqual(relay.snapshot()['latest']['link_health'], dict(
            queued=128, capacity=4096, stalls=4, failed=1, maxwrite=500, connections=2))
