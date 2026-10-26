"""Persistent receipt-gap monitoring, independent of browser/CSV recording."""
import csv
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import threading
import time


class DropoutMonitor:
    threshold = .100

    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.Lock()
        self.running = False
        self.path = None
        self.error = None
        self.last_at = self.last_wall = None
        self.active = False
        self.count = 0
        self.longest_ms = self.last_gap_ms = 0
        self.events = deque(maxlen=200)

    def start(self, session, mode):
        with self.lock:
            self.session, self.mode = session, mode
            self.running = mode != 'demo'
            self.path = None
            self.error = None
            self.last_at = self.last_wall = None
            self.active = False
            self.count = 0
            self.longest_ms = self.last_gap_ms = 0
            self.events.clear()
            if self.running:
                try:
                    self.directory.mkdir(parents=True, exist_ok=True)
                    self.path = self.directory / datetime.now(timezone.utc).strftime('dropouts-%Y%m%d-%H%M%S-%f.csv')
                    with self.path.open('x', newline='', encoding='utf-8') as stream:
                        csv.writer(stream).writerow(['event', 'gap_number', 'utc', 'last_batch_utc', 'gap_ms', 'session', 'source'])
                except OSError as exc:
                    self.error = str(exc)
                    self.path = None

    @staticmethod
    def utc(stamp):
        return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec='milliseconds')

    def _write(self, event, now, wall):
        self.events.append(dict(event=event, gap_number=self.count, utc=self.utc(wall),
                                last_batch_utc=self.utc(self.last_wall), gap_ms=round((now - self.last_at) * 1000, 3)))
        if not self.path or self.error:
            return
        try:
            # Close each row so an overnight crash retains earlier events.
            with self.path.open('a', newline='', encoding='utf-8') as stream:
                csv.writer(stream).writerow([event, self.count, self.utc(wall), self.utc(self.last_wall),
                                            round((now - self.last_at) * 1000, 3), self.session, self.mode])
        except OSError as exc:
            self.error = str(exc)

    def _check(self, now, wall):
        if not self.running or self.last_at is None:
            return
        elapsed_ms = max(0, now - self.last_at) * 1000
        self.longest_ms = max(self.longest_ms, elapsed_ms)
        if now > self.last_at + self.threshold and not self.active:
            self.active = True
            self.count += 1
            self._write('started', now, wall)

    def observe(self, now=None, wall=None):
        now = time.monotonic() if now is None else now
        wall = time.time() if wall is None else wall
        with self.lock:
            if not self.running:
                return
            self._check(now, wall)
            if self.active:
                self.last_gap_ms = max(0, now - self.last_at) * 1000
                self._write('recovered', now, wall)
                self.active = False
            self.last_at, self.last_wall = now, wall

    def tick(self):
        with self.lock:
            self._check(time.monotonic(), time.time())

    def stop(self):
        with self.lock:
            now, wall = time.monotonic(), time.time()
            self._check(now, wall)
            if self.active:
                self.last_gap_ms = max(0, now - self.last_at) * 1000
                self._write('monitor_stopped', now, wall)
                self.active = False
            self.running = False

    def snapshot(self):
        with self.lock:
            now = time.monotonic()
            current = max(0, now - self.last_at) * 1000 if self.active else 0
            return dict(count=self.count, threshold_ms=100, active=self.active,
                        current_gap_ms=round(current, 1), longest_gap_ms=round(max(self.longest_ms, current), 1),
                        last_gap_ms=round(self.last_gap_ms, 1), filename=self.path.name if self.path else None,
                        path=str(self.path) if self.path else None, error=self.error, running=self.running)

    def download(self):
        with self.lock:
            if not self.path:
                raise ValueError('No dropout log yet. Connect to hardware first.')
            return self.path.name, self.path.read_bytes()

    def recent_events(self):
        with self.lock:
            return dict(events=list(self.events), limit=200, count=self.count)
