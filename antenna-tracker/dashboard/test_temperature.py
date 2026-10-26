import csv
from pathlib import Path
import tempfile
import unittest

from relay import Relay
from temperature_log import TemperatureLog
from test_adc_stream import record, packet


class TemperatureTests(unittest.TestCase):
    def test_logs_every_sample_independently_of_full_rate_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            relay = Relay()
            relay.temperature_log = TemperatureLog(directory)
            relay.temperature_log.start('tcp')
            for i in range(5):
                relay.temperature_line(f'Chip temperature: US={i * 200000 + 1} C={40 + i}.50')
            self.assertFalse(relay.recorder.snapshot()['active'])
            snapshot = relay.snapshot()
            self.assertEqual(snapshot['temperature_log']['rows'], 5)
            self.assertEqual(snapshot['temperature']['celsius'], 44.5)
            name, body = relay.temperature_log.download()
            rows = list(csv.DictReader(body.decode().splitlines()))
            self.assertEqual(len(rows), 5)
            self.assertEqual(rows[-1]['device_us'], '800001')
            records = [record(1, 1000000)]
            relay.adc_batch(records, packet(records))
            self.assertEqual(relay.snapshot()['latest']['chip_temperature']['celsius'], 44.5)
            relay.temperature_line('Chip temperature: US=1000001 C=nan')
            self.assertIsNone(relay.snapshot()['temperature']['celsius'])
            self.assertEqual(list(csv.DictReader(relay.temperature_log.download()[1].decode().splitlines()))[-1]['chip_temp_c'], '')
            relay.temperature_log.stop()
            relay.temperature_line('Chip temperature: US=1200001 C=45.00')
            self.assertEqual(relay.temperature_log.snapshot()['rows'], 6)
            self.assertTrue(Path(directory, name).exists())

    def test_invalid_lines_do_not_replace_temperature(self):
        relay = Relay()
        relay.temperature_line('Chip temperature: US=200000 C=-5.25')
        relay.temperature_line('Chip temperature: US=oops C=5')
        self.assertEqual(relay.snapshot()['temperature']['celsius'], -5.25)
