"""Automatically persist each chip-temperature sample during hardware sessions."""
import csv
from datetime import datetime, timezone
from pathlib import Path
import threading


class TemperatureLog:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.Lock()
        self.path = None
        self.running = False
        self.rows = 0
        self.error = None

    def start(self, mode):
        with self.lock:
            self.path, self.error, self.rows = None, None, 0
            self.running = mode != 'demo'
            if not self.running:
                return
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
                self.path = self.directory / datetime.now(timezone.utc).strftime('temperature-%Y%m%d-%H%M%S-%f.csv')
                with self.path.open('x', newline='', encoding='utf-8') as stream:
                    csv.writer(stream).writerow(['received_utc', 'device_us', 'chip_temp_c'])
            except OSError as exc:
                self.error, self.path = str(exc), None

    def feed(self, sample):
        with self.lock:
            if not self.running or not self.path or self.error:
                return
            try:
                with self.path.open('a', newline='', encoding='utf-8') as stream:
                    csv.writer(stream).writerow([
                        datetime.fromtimestamp(sample['received_at'], timezone.utc).isoformat(timespec='milliseconds'),
                        sample['device_us'], sample['celsius'] if sample['celsius'] is not None else ''])
                self.rows += 1
            except OSError as exc:
                self.error = str(exc)

    def stop(self):
        with self.lock:
            self.running = False

    def snapshot(self):
        with self.lock:
            return dict(rows=self.rows, error=self.error, running=self.running,
                        filename=self.path.name if self.path else None,
                        path=str(self.path) if self.path else None)

    def download(self):
        with self.lock:
            if not self.path:
                raise ValueError('No temperature log yet. Connect to hardware first.')
            return self.path.name, self.path.read_bytes()
