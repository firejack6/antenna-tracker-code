import csv
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.request import urlopen

from dropouts import DropoutMonitor
from relay import DashboardServer, Handler, Relay


class DropoutServerTests(unittest.TestCase):
    def test_watchdog_logs_without_browser_and_downloads_current_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            server = DashboardServer(('127.0.0.1', 0), Handler)
            server.relay = Relay()
            server.relay.dropouts = DropoutMonitor(directory)
            monitor = server.relay.dropouts
            monitor.start(1, 'tcp')
            monitor.observe(time.monotonic() - .2, time.time() - .2)
            worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
            worker.start()
            try:
                deadline = time.monotonic() + 2
                while not monitor.snapshot()['active'] and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(monitor.snapshot()['count'], 1)
                with urlopen(f'http://127.0.0.1:{server.server_port}/api/dropouts/download') as response:
                    rows = list(csv.DictReader(response.read().decode().splitlines()))
                    self.assertIn('attachment;', response.headers['Content-Disposition'])
                self.assertEqual(rows[0]['event'], 'started')
                self.assertGreater(float(rows[0]['gap_ms']), 100)
                with urlopen(f'http://127.0.0.1:{server.server_port}/api/dropouts/events') as response:
                    events = json.load(response)
                self.assertEqual(events['events'][0]['event'], 'started')
                self.assertEqual(events['count'], 1)
            finally:
                server.shutdown()
                worker.join(2)
                monitor.stop()
                server.server_close()
