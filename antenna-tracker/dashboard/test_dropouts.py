import csv
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dropouts import DropoutMonitor


class DropoutTests(unittest.TestCase):
    def test_threshold_short_gap_and_recovery_without_watchdog_poll(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor = DropoutMonitor(directory)
            monitor.start(1, 'tcp')
            monitor.observe(1, 1000)
            monitor.observe(1.1, 1000.1)  # Exactly 100 ms is not over 100 ms.
            self.assertEqual(monitor.snapshot()['count'], 0)
            monitor.observe(1.25, 1000.25)
            state = monitor.snapshot()
            self.assertEqual(state['count'], 1)
            self.assertFalse(state['active'])
            self.assertEqual(state['last_gap_ms'], 150)
            name, body = monitor.download()
            rows = list(csv.DictReader(body.decode().splitlines()))
            self.assertEqual([row['event'] for row in rows], ['started', 'recovered'])
            self.assertEqual([row['gap_number'] for row in rows], ['1', '1'])
            self.assertEqual(float(rows[-1]['gap_ms']), 150)
            self.assertTrue(Path(directory, name).exists())

    def test_permanent_outage_counted_once_without_browser_then_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor = DropoutMonitor(directory)
            monitor.start(1, 'tcp')
            monitor.observe(10, 1000)
            for now in (10.11, 11, 20):
                with patch('dropouts.time.monotonic', return_value=now), patch('dropouts.time.time', return_value=1000 + now - 10):
                    monitor.tick()
            with patch('dropouts.time.monotonic', return_value=20):
                state = monitor.snapshot()
            self.assertEqual(state['count'], 1)
            self.assertTrue(state['active'])
            self.assertEqual(state['current_gap_ms'], 10000)
            self.assertEqual(len(monitor.download()[1].decode().splitlines()), 2)
            monitor.observe(21, 1011)
            self.assertEqual(monitor.snapshot()['last_gap_ms'], 11000)
            self.assertEqual(monitor.snapshot()['count'], 1)

    def test_intentional_disconnect_and_new_session_preserve_previous_log(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor = DropoutMonitor(directory)
            monitor.start(1, 'tcp')
            monitor.observe(1, 1000)
            with patch('dropouts.time.monotonic', return_value=1.05), patch('dropouts.time.time', return_value=1000.05):
                monitor.stop()
            with patch('dropouts.time.monotonic', return_value=20): monitor.tick()
            self.assertEqual(monitor.snapshot()['count'], 0)
            old = monitor.path
            monitor.start(2, 'tcp')
            self.assertNotEqual(old, monitor.path)
            self.assertTrue(old.exists())
            monitor.start(3, 'demo')
            monitor.observe(1, 1000)
            monitor.observe(20, 1019)
            self.assertEqual(monitor.snapshot()['count'], 0)

    def test_disk_error_is_reported_without_breaking_receipt_monitor(self):
        with tempfile.TemporaryDirectory() as directory:
            invalid = Path(directory, 'not-a-directory')
            invalid.write_text('x')
            monitor = DropoutMonitor(invalid)
            monitor.start(1, 'tcp')
            monitor.observe(1, 1000)
            monitor.observe(2, 1001)
            self.assertIsNotNone(monitor.snapshot()['error'])
            self.assertEqual(monitor.snapshot()['count'], 1)
