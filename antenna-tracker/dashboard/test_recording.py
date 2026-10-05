import csv
from pathlib import Path
import tempfile
import time
import unittest
from recording import Recorder


class RecordingTests(unittest.TestCase):
    def test_full_rate_csv_preserves_timestamps_raw_scaling_and_invalid_channels(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = Recorder(directory)
            scaling = [dict(m=4, b=-1) for _ in range(16)]
            recorder.start(scaling)
            metadata = dict(device_ms=12, accel=[1, 2, 3], gpio={'46': 1})
            started = time.perf_counter()
            for offset in range(0, 10000, 128):
                records = [(i, 123456789000 + i * 100, 0xFFFE if i == 1 else 0xFFFF, *([2048] * 16)) for i in range(offset, min(offset+128,10000))]
                recorder.feed(records, 1720000000.5, metadata)
            stopped = recorder.stop()
            duration = time.perf_counter() - started
            self.assertFalse(stopped['error'])
            self.assertEqual(stopped['rows'], 10000)
            with Path(stopped['path']).open(newline='') as output: rows = list(csv.DictReader(output))
            self.assertEqual(rows[0]['device_us'], '123456789000')
            self.assertEqual(rows[-1]['device_us'], '123457788900')
            self.assertEqual(rows[1]['ch0_raw'], '')
            self.assertEqual(rows[0]['ch0_volts'], '2.5')
            self.assertEqual(rows[0]['ch0_scaled'], '9.0')
            self.assertEqual(rows[0]['gpio46'], '1')
            self.assertEqual(rows[0]['sensor_device_ms'], '12')
            print(f'10k full-rate CSV rows: {duration:.3f}s')
            self.assertLess(duration, 1.0, 'CSV writer must keep up with 10k scans/s')
