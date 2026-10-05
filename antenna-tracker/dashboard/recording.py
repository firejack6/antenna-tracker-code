"""Full-rate CSV recording on a separate disk writer, independent of live plots."""
import csv
from datetime import datetime, timezone
from pathlib import Path
import queue
import threading


class Recorder:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.Lock()
        self.active = False
        self.rows = 0
        self.error = ''
        self.path = None
        self.worker = None

    def snapshot(self):
        with self.lock:
            return dict(active=self.active, finishing=bool(not self.active and self.worker and self.worker.is_alive()), rows=self.rows, error=self.error,
                        filename=self.path.name if self.path else None,
                        path=str(self.path) if self.path else None)

    def start(self, scaling):
        if not isinstance(scaling, list) or len(scaling) != 16:
            raise ValueError('Provide scaling for all 16 channels')
        import math
        for item in scaling:
            if not isinstance(item, dict) or any(type(item.get(k)) not in (float, int) or not math.isfinite(item[k]) for k in ('m', 'b')):
                raise ValueError('Scaling must be finite')
        with self.lock:
            if self.active or (self.worker and self.worker.is_alive()):
                raise ValueError('A CSV recording is already running or finishing')
            self.directory.mkdir(parents=True, exist_ok=True)
            self.path = self.directory / ('telemetry-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f') + '.csv')
            # Open synchronously so an unwritable destination is reported to the UI.
            output = self.path.open('w', newline='', encoding='utf-8')
            self.pending = queue.Queue(maxsize=256)
            self.scaling = [(item['m'], item['b']) for item in scaling]
            self.rows, self.error, self.active = 0, '', True
            self.worker = threading.Thread(target=self._write, args=(output,), daemon=True)
            self.worker.start()
        return self.snapshot()

    def feed(self, records, received, metadata):
        with self.lock:
            if not self.active: return
            try:
                self.pending.put_nowait((records, received, metadata))
            except queue.Full:
                self.error = 'CSV writer cannot keep up; recording stopped before further data loss.'
                self.active = False

    def stop(self):
        with self.lock:
            self.active = False
            worker = self.worker
        if worker:
            worker.join(15)
            if worker.is_alive():
                raise ValueError('CSV is still finishing; wait and retry')
        return self.snapshot()

    def _write(self, output):
        header = ['received_utc', 'device_us', 'adc_sequence', 'valid_mask', 'sensor_device_ms']
        header += [f'ch{i}_{kind}' for kind in ('raw', 'volts', 'scaled') for i in range(16)]
        header += [f'{kind}_{axis}' for kind in ('accel_g', 'gyro_dps', 'mag_uT') for axis in ('x', 'y', 'z')]
        header += ['gpio46', 'gpio4', 'gpio13', 'gpio14']
        try:
            with output:
                writer = csv.writer(output)
                writer.writerow(header)
                while True:
                    try:
                        records, received, metadata = self.pending.get(timeout=.1)
                    except queue.Empty:
                        with self.lock:
                            if not self.active: break
                        output.flush()
                        continue
                    utc = datetime.fromtimestamp(received, timezone.utc).isoformat(timespec='microseconds')
                    sensor = [metadata.get('device_ms', '')]
                    imu = [value for kind in ('accel', 'gyro', 'mag') for value in (metadata.get(kind) or ['', '', ''])]
                    gpio = [metadata.get('gpio', {}).get(str(i), metadata.get('gpio', {}).get(i, '')) for i in (46, 4, 13, 14)]
                    rows = []
                    for sequence, stamp, valid, *counts in records:
                        raw = [value if valid & (1 << i) and value <= 4095 else '' for i, value in enumerate(counts)]
                        volts = [value * 5.0 / 4096 if value != '' else '' for value in raw]
                        scaled = [value * self.scaling[i][0] + self.scaling[i][1] if value != '' else '' for i, value in enumerate(volts)]
                        rows.append([utc, stamp, sequence, valid, *sensor, *raw, *volts, *scaled, *imu, *gpio])
                    writer.writerows(rows)
                    with self.lock: self.rows += len(rows)
        except Exception as exc:
            with self.lock: self.error, self.active = str(exc), False
