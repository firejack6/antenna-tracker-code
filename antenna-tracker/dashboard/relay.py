"""Local browser dashboard for the existing ADS7953/BMI323/BMM350 text stream."""
from __future__ import annotations

import argparse
from collections import deque
import codecs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import queue
import shutil
import socket
import subprocess
import threading
import time
import tempfile
from urllib.parse import parse_qs, urlsplit
import webbrowser
from adc_stream import Stream
from recording import Recorder
from dropouts import DropoutMonitor
from temperature_log import TemperatureLog
from status_protocol import decode_status

ROOT = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
VECTOR = re.compile(r"^(Accel g|Gyro dps|Mag uT) \(x,y,z\):\s*(.*)$")
REMOTE_RETRY_DELAYS = (1, 2, 4)
TCP_RECONNECT_SECONDS = 5


class Parser:
    """Accept complete firmware lines; never reuse values from an older frame."""
    def __init__(self, emit):
        self.emit = emit
        self.frame = None

    def flush(self):
        if self.frame is not None:
            self.emit(self.frame)
            self.frame = None

    def line(self, line):
        line = ANSI.sub("", line).strip()
        stamp = re.fullmatch(r"Time ms:\s*(\d+)", line)
        if stamp:
            self.flush()
            self.frame = dict(device_ms=int(stamp[1]), received_at=time.time(),
                              adc=[None] * 16, accel=None, gyro=None, mag=None,
                              gpio={str(pin): None for pin in (46, 4, 13, 14)}, servos={}, errors=[])
        elif not line:
            self.flush()
        elif self.frame is not None:
            if line.startswith("ADC raw"):
                for channel, value in re.findall(r"\bCH(\d+)=(ERR|\d+)\b", line):
                    channel = int(channel)
                    if channel < 16:
                        number = None if value == "ERR" else int(value)
                        self.frame["adc"][channel] = number if number is not None and number <= 4095 else None
            elif line.startswith("GPIO states:"):
                for pin, value in re.findall(r"\bGPIO(46|4|13|14)=(\S+)", line):
                    self.frame["gpio"][pin] = int(value) if value in ("0", "1") else None
            elif match := re.fullmatch(r"Servo (PAN|TILT|S3): (.*)", line):
                fields = {key.lower(): int(value) for key, value in re.findall(r"\b([A-Z]+)=(\d+)\b", match[2])}
                required = {'gpio', 'pmin', 'pcenter', 'pmax', 'fmin', 'fcenter', 'fmax', 'pulse', 'freq', 'enable', 'ready'}
                if required <= fields.keys():
                    self.frame['servos'][match[1]] = fields
            elif match := re.fullmatch(r'Motion (PAN|TILT): (.*)', line):
                fields = {}
                for key, value in re.findall(r'([A-Z]+)=(\S+)', match[2]):
                    number = float(value)
                    fields[key.lower()] = number if math.isfinite(number) else None
                self.frame.setdefault('servo_motion', {})[match[1]] = fields
            elif match := re.fullmatch(r'Tilt IMU: (.*)', line):
                self.frame['tilt_imu'] = {key.lower(): (float(value) if math.isfinite(float(value)) else None)
                    for key,value in re.findall(r'([A-Z]+)=(\S+)',match[1])}
            elif match := re.fullmatch(r'Position (PAN|TILT): (.*)', line):
                fields = {}
                for key, value in re.findall(r'([A-Z]+)=(\S+)', match[2]):
                    number = float(value)
                    fields[key.lower()] = number if math.isfinite(number) else None
                self.frame.setdefault('servo_position', {})[match[1]] = fields
            elif match := re.fullmatch(r'PID (PAN|TILT): (.*)', line):
                fields = {}
                for key, value in re.findall(r'([A-Z]+)=(\S+)', match[2]):
                    number = float(value)
                    fields[key.lower()] = number if math.isfinite(number) else None
                self.frame.setdefault('servo_pid', {})[match[1]] = fields
            elif line.startswith(('Tilt config:', 'Pan config:')):
                fields = {}
                for key, value in re.findall(r'([A-Z]+)=(\S+)', line):
                    number = float(value)
                    fields[key.lower()] = number if math.isfinite(number) else None
                self.frame['pan_config' if line.startswith('Pan') else 'tilt_config'] = fields
            elif line.startswith('Servo error:'):
                self.frame['errors'].append(line)
            elif line.startswith('Sensor error:'):
                self.frame['errors'].append(line)
            elif line.startswith('Rates:'):
                self.frame['rates'] = {key.lower(): float(value) for key, value in re.findall(r'([A-Z]+)=([\d.]+)', line)}
            elif line.startswith('Link health:'):
                self.frame['link_health'] = {key.lower(): int(value) for key, value in re.findall(r'([A-Z]+)=(\d+)', line)}
            elif line.startswith('ADC mode:'):
                self.frame['adc_mode'] = {key.lower(): int(value) for key, value in re.findall(r'([A-Z]+)=(-?\d+)', line)}
            elif line.startswith('ADC error:'):
                self.frame['errors'].append(line)
            elif line.startswith('Ranges:'):
                self.frame['ranges'] = {key.lower(): int(value) for key, value in re.findall(r'([A-Z]+)=(\d+)', line)}
            elif match := VECTOR.fullmatch(line):
                key = {"Accel g": "accel", "Gyro dps": "gyro", "Mag uT": "mag"}[match[1]]
                try:
                    values = [float(v) for v in match[2].split(",")]
                    if len(values) != 3 or not all(math.isfinite(v) for v in values):
                        raise ValueError()
                    self.frame[key] = values
                except ValueError:
                    self.frame["errors"].append("Invalid " + key + " reading")
            elif any(word in line.lower() for word in ("failed", "unavailable", "mismatch")):
                self.frame["errors"].append(line)


class Lines:
    """Incremental UTF-8 and line decoding, including split serial reads."""
    def __init__(self, callback):
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.pending = ""
        self.callback = callback

    def feed(self, chunk):
        self.pending += self.decoder.decode(chunk)
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            self.callback(line.rstrip("\r")[:16384])
        if len(self.pending) > 16384:
            self.callback("[Discarded oversized serial line]")
            self.pending = ""


def pio_command():
    explicit = os.environ.get("PIO_EXECUTABLE")
    found = explicit or shutil.which("pio") or shutil.which("platformio")
    if not found:
        scripts = "Scripts" if os.name == "nt" else "bin"
        candidate = Path.home() / ".platformio" / "penv" / scripts / ("pio.exe" if os.name == "nt" else "pio")
        if candidate.is_file():
            found = str(candidate)
    if not found:
        raise RuntimeError("PlatformIO not found. Set PIO_EXECUTABLE to your pio executable.")
    return [found]


def process_options():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def remote_command(agent, port, baud, directory):
    # --sock is the bridge used by PlatformIO's own remote terminal (Core 6.2.0).
    # It avoids launching the interactive terminal and its stdin/TTY requirement.
    return pio_command() + ["remote", "--agent", agent, "device", "monitor",
                            "--port", port, "--baud", str(baud), "--parity", "N", "--dtr", "1",
                            "--rts", "0", "--sock", str(directory)]


def list_ports(mode, agent):
    if mode == "direct":
        try:
            from serial.tools import list_ports as serial_ports
        except ImportError as exc:
            raise RuntimeError("Install dashboard/requirements.txt or use start-dashboard.ps1.") from exc
        return [{"port": p.device, "description": p.description} for p in serial_ports.comports()]
    if mode != "remote" or not agent.strip() or len(agent) > 200:
        raise ValueError("Choose remote or direct mode and supply a remote agent name.")
    result = subprocess.run(pio_command() + ["remote", "--agent", agent, "device", "list", "--json-output"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=25, text=True, encoding="utf-8", errors="replace", **process_options())
    # PlatformIO can print a notice before the JSON document.
    for line in reversed(result.stdout.splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and result.returncode == 0:
            return [{"port": p["port"], "description": p.get("description", ""), "agent": name}
                    for name, ports in data.items() for p in ports]
    raise RuntimeError((result.stderr or result.stdout or "Remote port discovery failed")[-2000:])


class Relay:
    def __init__(self):
        self.lock = threading.Lock()
        self.control = threading.Lock()
        self.samples = deque(maxlen=10000)
        self.logs = deque(maxlen=400)
        self.sequence = 0
        self.session = 0
        self.status = "disconnected"
        self.message = "Choose a source to start streaming."
        self.mode = None
        self.worker = None
        self.stop = threading.Event()
        self.commands = queue.Queue(maxsize=32)
        self.servo_command_status = {}
        self.priority_commands = queue.Queue(maxsize=8)
        self.servo_safety = None
        self.safety_command = None
        self.servo_inhibit = True
        self.raw_batches = deque(maxlen=2048)
        self.raw_scans = self.sequence_gaps = self.corrupt_packets = 0
        self.receipt_history = deque()
        self.health_history = deque()
        self.last_batch_at = None
        self.health_started_at = time.monotonic()
        self.tcp_connections = 0
        self.tcp_last_received = None
        self.tcp_max_receive_gap_ms = 0
        self.tcp_max_decode_ms = 0
        self.last_adc_sequence = self.last_adc_us = self.adc_time_offset = None
        self.telemetry = None
        self.binary_active = False
        self.recorder = Recorder(ROOT / 'recordings')
        self.dropouts = DropoutMonitor(ROOT / 'health-logs')
        self.temperature_log = TemperatureLog(ROOT / 'health-logs')
        self.temperature = None

    def corrupt_packet(self):
        with self.lock:
            self.corrupt_packets += 1

    def temperature_line(self, text):
        match = re.fullmatch(r'Chip temperature: US=(\d+) C=(-?\d+(?:\.\d+)?|nan)', text)
        if not match:
            return
        celsius = float(match[2])
        sample = dict(device_us=int(match[1]), celsius=celsius if math.isfinite(celsius) else None, received_at=time.time())
        with self.lock:
            self.temperature = sample
        self.temperature_log.feed(sample)

    def status_frame(self, payload):
        """ATS1 binary status → same telemetry dict keys as the text Parser."""
        frame = decode_status(payload)
        received = time.time()
        armed, estop = frame.pop('_armed'), frame.pop('_estop')
        chip_c, chip_us = frame.pop('_chip_temp_c'), frame.pop('_chip_temp_us')
        range_failed = frame.pop('_range_failed')
        frame['received_at'] = received
        if range_failed:
            frame.setdefault('errors', []).append('Sensor error: range change failed')
        with self.lock:
            self.servo_safety = dict(armed=armed, estop=estop, received_at=received)
            pending = self.safety_command
            target = dict(ENABLE=(1, 0), DISABLE=(0, None), ESTOP=(0, 1), CLEAR=(0, 0))
            if pending and 'sent_at' in pending:
                expected = target[pending['action']]
                if armed == expected[0] and (expected[1] is None or estop == expected[1]):
                    pending.update(state='applied', message='Board confirmed ' + pending['action'])
                    self.servo_inhibit = not bool(armed)
            elif not pending:
                self.servo_inhibit = not bool(armed)
        if chip_us:
            sample = dict(device_us=int(chip_us), celsius=chip_c, received_at=received)
            with self.lock:
                self.temperature = sample
            self.temperature_log.feed(sample)
        self.sample(frame)

    def adc_batch(self, records, packet):
        received = time.time()
        receipt_time = time.monotonic()
        self.dropouts.observe(receipt_time, received)
        with self.lock:
            metadata = dict(self.telemetry or {})
            metadata['chip_temperature'] = dict(self.temperature) if self.temperature else None
        self.recorder.feed(records, received, metadata)
        with self.lock:
            self.binary_active = True
            self.raw_batches.append(packet)
            # Refine the device-to-wall clock anchor as startup backlog drains.
            # Browser uses this shared anchor for all retained device timestamps.
            candidate = received - records[-1][1] / 1e6
            if self.adc_time_offset is not None and records[-1][1] >= (self.last_adc_us or 0) and candidate < self.adc_time_offset:
                self.adc_time_offset = candidate
            columns = [[] for _ in range(16)]
            batch_gaps = 0
            for sequence, stamp, valid, *raw in records:
                reboot = self.last_adc_us is not None and stamp < self.last_adc_us
                if reboot or self.adc_time_offset is None:
                    self.adc_time_offset = received - records[-1][1] / 1e6
                if self.last_adc_sequence is not None and not reboot:
                    gap = (sequence - self.last_adc_sequence - 1) & 0xFFFFFFFF
                    self.sequence_gaps += gap
                    batch_gaps += gap
                self.last_adc_sequence, self.last_adc_us = sequence, stamp
                for channel, value in enumerate(raw):
                    if valid & (1 << channel) and value <= 4095:
                        columns[channel].append(value)
            self.raw_scans += len(records)
            self.last_batch_at = receipt_time
            self.health_history.append((receipt_time, len(records), batch_gaps, len(packet)))
            while self.health_history and self.health_history[0][0] <= receipt_time - 10:
                self.health_history.popleft()
            self.receipt_history.append((receipt_time, self.raw_scans))
            while len(self.receipt_history) > 2 and self.receipt_history[1][0] < receipt_time - 2:
                self.receipt_history.popleft()
            sequence, stamp, valid, *raw = records[-1]
            frame = dict(self.telemetry or dict(accel=None, gyro=None, mag=None, gpio={}, servos={}, errors=[]))
            frame['chip_temperature'] = metadata['chip_temperature']
            frame.update(device_ms=stamp / 1000, device_us=stamp, adc_sequence=sequence,
                         sensor_device_ms=metadata.get('device_ms'),
                         sensor_received_at=metadata.get('received_at'),
                         received_at=received, plot_at=stamp / 1e6 + self.adc_time_offset,
                         adc=[v if valid & (1 << i) and v <= 4095 else None for i, v in enumerate(raw)],
                         adc_min=[min(c) if c else None for c in columns],
                         adc_max=[max(c) if c else None for c in columns], scan_count=len(records))
            frame['adc_mean'] = [sum(c) / len(c) if c else None for c in columns]
            self.sequence += 1
            self.samples.append(dict(frame, id=self.sequence))

    def command_ranges(self, data):
        accel, gyro = data.get('accel'), data.get('gyro')
        if type(accel) is not int or accel not in (2, 4, 8, 16) or type(gyro) is not int or gyro not in (125, 250, 500, 1000, 2000):
            raise ValueError('Unsupported acceleration or gyro range')
        with self.control, self.lock:
            latest = self.samples[-1] if self.samples else None
            if self.status != 'connected' or not latest or time.time() - latest['received_at'] > 3 or latest.get('ranges', {}).get('ready') != 1:
                raise ValueError('Connect and wait for ready BMI323 telemetry')
            try:
                self.commands.put_nowait(f'RANGE {accel} {gyro}\n'.encode('ascii'))
            except queue.Full:
                raise ValueError('Command queue is full')

    def command_adc_channel(self, data):
        channel = data.get('channel')
        if type(channel) is not int or not -1 <= channel <= 15:
            raise ValueError('Choose ALL (-1) or a channel from 0 to 15')
        with self.control, self.lock:
            latest = self.samples[-1] if self.samples else None
            if self.status != 'connected' or not latest or time.time() - latest['received_at'] > 3 or not latest.get('adc_mode'):
                raise ValueError('Connect and wait for ADC mode telemetry from updated firmware')
            try:
                self.commands.put_nowait(f'ADC CHANNEL {"ALL" if channel == -1 else channel}\n'.encode())
            except queue.Full:
                raise ValueError('Command queue is full')

    def command_adc_stream(self, data):
        """Lean mode: stop ATB2 batch TX while ESP keeps sampling for servo feedback."""
        if 'enabled' not in data or type(data['enabled']) is not bool:
            raise ValueError('enabled must be true (full ADC stream) or false (lean)')
        with self.control, self.lock:
            if self.status != 'connected':
                raise ValueError('Connect to the board first')
            try:
                self.commands.put_nowait(f'ADC STREAM {"ON" if data["enabled"] else "OFF"}\n'.encode())
            except queue.Full:
                raise ValueError('Command queue is full')

    def command_tilt(self, data):
        action = data.get('action')
        if action not in ('configure', 'zero', 'sweep_start', 'sweep_stop', 'sweep_apply'):
            raise ValueError('Unknown TILT calibration action')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected': raise ValueError('Connect to the board first')
            if action != 'sweep_stop' and (not latest or time.time() - latest['received_at'] > 3 or not latest.get('tilt_config')):
                raise ValueError('Wait for fresh TILT calibration telemetry')
            if action == 'sweep_start':
                if self.servo_inhibit or not self.servo_safety or not self.servo_safety['armed'] or self.servo_safety['estop']:
                    raise ValueError('Enable servos before starting the sweep')
                speed, direction, cap = data.get('speed', 5), data.get('direction', 1), data.get('cap', 300)
                if type(speed) not in (int, float) or not math.isfinite(speed) or not 1 <= speed <= 100 or type(direction) is not int or direction not in (-1, 1):
                    raise ValueError('Sweep speed must be 1–100 deg/s; direction must be +1 or -1')
                if type(cap) not in (int, float) or not math.isfinite(cap) or not 1 <= cap <= 1000:
                    raise ValueError('Sweep PWM offset cap must be 1–1000 µs')
                command = f'TILT SWEEP START {speed:g} {direction} {cap:g}\n'
                if any(key in data for key in ('polarity', 'minimum', 'rotations')):
                    polarity = data.get('polarity', 1)
                    if type(polarity) is not int or polarity not in (-1, 1):
                        raise ValueError('PWM polarity must be +1 or -1')
                    command = command.rstrip('\n') + f' {polarity}\n'
                if 'minimum' in data or 'rotations' in data:
                    minimum, rotations = data.get('minimum', min(42, cap)), data.get('rotations', 1)
                    if type(minimum) not in (int, float) or not math.isfinite(minimum) or not 0 <= minimum <= cap:
                        raise ValueError('Sweep minimum offset must be between zero and the PWM cap')
                    if type(rotations) is not int or not 1 <= rotations <= 20:
                        raise ValueError('Sweep rotations must be a whole number from 1 to 20')
                    command = command.rstrip('\n') + f' {minimum:g} {rotations}\n'
            elif action == 'configure':
                values = [data.get(key) for key in ('vmin', 'vmax', 'zero', 'amin', 'amax')]
                if not all(type(v) in (int, float) and math.isfinite(v) for v in values): raise ValueError('Enter finite calibration values')
                vmin, vmax, zero, amin, amax = values
                if not (0 <= vmin < vmax <= 5 and vmax - vmin >= .1 and 0 <= zero <= 360 and -360 <= amin < amax <= 360 and amax - amin <= 360):
                    raise ValueError('Use a voltage span ≥0.1 V, zero 0–360°, and angle limits spanning at most 360°')
                command = 'TILT CONFIG ' + ' '.join(f'{value:g}' for value in values) + '\n'
            else:
                if action == 'sweep_apply' and latest['tilt_config'].get('sweep') != 2:
                    raise ValueError('Complete the sweep before applying its voltage range')
                command = {'zero': 'TILT ZERO\n', 'sweep_stop': 'TILT SWEEP STOP\n', 'sweep_apply': 'TILT SWEEP APPLY\n'}[action]
            try: (self.priority_commands if action == 'sweep_stop' else self.commands).put_nowait(command.encode('ascii'))
            except queue.Full: raise ValueError('Control queue is full')

    def command_tilt_imu(self, data):
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time()-latest['received_at'] > 3 or not latest.get('tilt_imu'):
                raise ValueError('Wait for fresh IMU controller telemetry')
            if data.get('action') == 'zero': command = 'TILT IMU ZERO\n'
            elif data.get('action') == 'configure':
                axis = data.get('axis'); values = [data.get(k) for k in ('zero','amin','amax')]
                if type(axis) is not int or axis not in (0,1) or not all(type(v) in (int,float) and math.isfinite(v) and abs(v)<=720 for v in values) or not 1 <= abs(values[2]-values[1]) <= 180:
                    raise ValueError('Choose X/Y axis and finite mapping angles spanning 1?180 degrees')
                command = f'TILT IMU CONFIG {axis} ' + ' '.join(f'{v:g}' for v in values)
                if 'pmin' in data or 'pmax' in data:
                    pmin,pmax = data.get('pmin'),data.get('pmax')
                    if type(pmin) is not int or type(pmax) is not int or not 500 <= pmin < pmax <= 2500: raise ValueError('Mapped PWM points must be ordered within 500?2500 us')
                    command += f' {pmin} {pmax}'
                command += '\n'
            else: raise ValueError('Choose configure or zero')
            try: self.commands.put_nowait(command.encode('ascii'))
            except queue.Full: raise ValueError('Control queue is full')

    def command_pan(self, data):
        action = data.get('action')
        if action in ('save', 'zero'):
            command = f'PAN {action.upper()}\n'
        elif action == 'configure':
            limits = [('neutral',500,2500), ('polarity',-1,1), ('vmin',0,3.5), ('vmax',0,3.5),
                      ('span',-360,360), ('zero',-360,360), ('amin',-360,360), ('amax',-360,360)]
            values = []
            for key, lower, upper in limits:
                value = data.get(key)
                if type(value) not in (int,float) or not math.isfinite(value) or not lower <= value <= upper:
                    raise ValueError(f'Invalid PAN {key}')
                values.append(value)
            if values[1] not in (-1,1) or values[3]-values[2] < .1 or abs(values[4]) < 1 or values[6] >= values[7]:
                raise ValueError('Use polarity +1/-1, voltage span >= 0.1 V, angle span >= 1 degree, and min < max')
            # Compact fields fit the firmware command buffer; UI precision follows this.
            command = 'PAN CONFIG ' + ' '.join(f'{v:.5g}' for v in values) + '\n'
        elif action == 'cr_configure':
            limits = [('ff',0,50), ('rise',1,500), ('fall',1,1000), ('search',0,100), ('search_max',0,200), ('brake',0,2)]
            values = []
            for key, lower, upper in limits:
                value = data.get(key)
                if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
                    raise ValueError(f'Invalid PAN CR {key} (expected {lower}–{upper})')
                values.append(value)
            command = 'PAN CR CONFIG ' + ' '.join(f'{v:g}' for v in values) + '\n'
        else:
            raise ValueError('Choose configure, cr_configure, zero, or save')
        if len(command) > 79: raise ValueError('PAN configuration is too long; use fewer decimal places')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time()-latest['received_at'] > 3 or 'pan_config' not in latest:
                raise ValueError('Wait for fresh PAN configuration telemetry')
            try: self.commands.put_nowait(command.encode('ascii'))
            except queue.Full: raise ValueError('Control queue is full')

    def command_servo_position(self, data, gains=False):
        axis = data.get('axis')
        if axis not in ('PAN', 'TILT'):
            raise ValueError('Choose PAN or TILT')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time()-latest['received_at'] > 3 or axis not in latest.get('servo_position', {}):
                raise ValueError('Wait for fresh position-controller telemetry')
            if gains == 'ramp':
                enabled = data.get('enabled')
                if type(enabled) is not bool: raise ValueError('Ramp enabled must be a boolean')
                rate = data.get('rate')
                if rate is not None and (type(rate) not in (int,float) or not math.isfinite(rate) or not 0 < rate <= 360):
                    raise ValueError('Position ramp rate must be greater than 0 and at most 360 deg/s')
                command = f'SERVO RAMP {axis} {int(enabled)}' + (f' {rate:g}' if rate is not None else '') + '\n'
            elif gains == 'deadband':
                values = [data.get(key) for key in ('dbplus', 'dbminus')]
                if not all(type(v) in (int,float) and math.isfinite(v) and 0 <= v <= 1000 for v in values):
                    raise ValueError('Deadband offsets must be between 0 and 1000 us')
                command = f'SERVO DEADBAND {axis} ' + ' '.join(f'{v:g}' for v in values) + '\n'
            elif gains:
                limits = [('kp',0,100), ('ki',0,100), ('kd',0,100), ('ilimit',0,1000), ('cap',1,1000), ('tolerance',.1,30)]
                values = []
                for key, lower, upper in limits:
                    value = data.get(key)
                    if type(value) not in (int,float) or not math.isfinite(value) or not lower <= value <= upper:
                        raise ValueError(f'Invalid {key}: expected {lower} through {upper}')
                    values.append(f'{value:g}')
                command = f'SERVO PID {axis} ' + ' '.join(values) + '\n'
            else:
                if self.servo_inhibit or not self.servo_safety or not self.servo_safety['armed'] or self.servo_safety['estop']:
                    raise ValueError('Enable servos before commanding position')
                angle = data.get('angle')
                calibration = latest.get('tilt_config', {}) if axis == 'TILT' else {}
                motion = latest.get('servo_motion', {}).get(axis, {})
                imu = latest.get('tilt_imu',{}) if axis == 'TILT' else {}
                if imu.get('active'):
                    if not imu.get('ready'): raise ValueError('Calibrate the IMU PWM/angle mapping first')
                    lower,upper = motion.get('minangle',-360),motion.get('maxangle',360)
                else:
                    lower = max(calibration.get('amin',-360), motion.get('minangle',0))
                    upper = min(calibration.get('amax',360), motion.get('maxangle',360))
                if type(angle) not in (int,float) or not math.isfinite(angle) or not lower <= angle <= upper:
                    raise ValueError(f'Angle must be within {lower} through {upper} degrees')
                command = f'SERVO POSITION {axis} {angle:g}\n'
            try: self.commands.put_nowait(command.encode('ascii'))
            except queue.Full: raise ValueError('Control queue is full')

    def command_servo_speed(self, data):
        axis, speed = data.get('axis'), data.get('speed')
        if axis not in ('PAN', 'TILT') or type(speed) not in (int, float) or not math.isfinite(speed) or not 0 <= speed <= 360:
            raise ValueError('Choose PAN/TILT and a speed from 0 to 360 deg/s')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time() - latest['received_at'] > 3 or axis not in latest.get('servo_motion', {}):
                raise ValueError('Wait for fresh motion telemetry from updated firmware')
            try: self.commands.put_nowait(f'SERVO SPEED {axis} {speed:g}\n'.encode('ascii'))
            except queue.Full: raise ValueError('Command queue is full')

    def command_servo_pwm_sweep(self, data):
        axis, action = data.get('axis'), data.get('action')
        if axis not in ('PAN', 'TILT', 'S3') or action not in ('start', 'stop'):
            raise ValueError('Choose PAN/TILT/S3 and start or stop')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time() - latest['received_at'] > 3:
                raise ValueError('Connect and wait for fresh servo telemetry')
            servo = (latest.get('servos') or {}).get(axis)
            if not servo or servo.get('ready') != 1:
                raise ValueError(f'{axis} PWM output unavailable')
            if action == 'stop':
                command = f'SERVO PWM SWEEP {axis} STOP\n'
                try: self.priority_commands.put_nowait(command.encode('ascii'))
                except queue.Full: raise ValueError('Control queue is full')
                return
            if self.servo_inhibit or not self.servo_safety or not self.servo_safety['armed'] or self.servo_safety['estop']:
                raise ValueError('Enable servos before starting a PWM sweep')
            start, end, rate = data.get('start'), data.get('end'), data.get('rate')
            frequency = data.get('frequency', servo.get('fcenter', 50))
            pmin, pmax = servo.get('pmin', 500), servo.get('pmax', 2500)
            fmin, fmax = servo.get('fmin', 50), servo.get('fmax', 50)
            for label, value in (('start', start), ('end', end), ('rate', rate), ('frequency', frequency)):
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError(f'Enter a finite {label}')
            if not (pmin <= start <= pmax and pmin <= end <= pmax and start != end):
                raise ValueError(f'Start and end must differ and lie within {pmin}–{pmax} µs')
            if not 5 <= rate <= 200:
                raise ValueError('Sweep rate must be 5–200 µs/s')
            if not (fmin <= frequency <= fmax) or max(start, end) * frequency >= 1_000_000:
                raise ValueError('Frequency outside configured limits')
            command = f'SERVO PWM SWEEP {axis} {int(round(start))} {int(round(end))} {rate:g} {int(round(frequency))}\n'
            try: self.commands.put_nowait(command.encode('ascii'))
            except queue.Full: raise ValueError('Control queue is full')

    def command_servo_pwm_slew(self, data):
        axis, rate, accel = data.get('axis'), data.get('rate'), data.get('accel')
        if axis not in ('PAN', 'TILT', 'S3'):
            raise ValueError('Choose PAN/TILT/S3')
        if type(rate) not in (int, float) or type(accel) not in (int, float) or not math.isfinite(rate) or not math.isfinite(accel):
            raise ValueError('Enter finite rate (µs/s) and accel (µs/s²)')
        if not 0 <= rate <= 500 or not 0 <= accel <= 5000:
            raise ValueError('Rate must be 0–500 µs/s and accel 0–5000 µs/s² (0 disables slew)')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time() - latest['received_at'] > 3:
                raise ValueError('Connect and wait for fresh servo telemetry')
            if axis not in (latest.get('servos') or {}):
                raise ValueError('Wait for servo telemetry')
            command = f'SERVO PWM SLEW {axis} {rate:g} {accel:g}\n'
            try: self.commands.put_nowait(command.encode('ascii'))
            except queue.Full: raise ValueError('Command queue is full')

    def command_servo_overspeed(self, data):
        axis, enabled = data.get('axis'), data.get('enabled')
        if axis not in ('PAN', 'TILT') or type(enabled) is not bool:
            raise ValueError('Choose PAN/TILT and an enabled boolean')
        with self.control, self.lock:
            latest = self.telemetry if self.binary_active else (self.samples[-1] if self.samples else None)
            if self.status != 'connected' or not latest or time.time() - latest['received_at'] > 3 or 'osfault' not in latest.get('servo_motion', {}).get(axis, {}):
                raise ValueError('Wait for fresh overspeed telemetry from updated firmware')
            try: self.commands.put_nowait(f'SERVO OVERSPEED {axis} {int(enabled)}\n'.encode('ascii'))
            except queue.Full: raise ValueError('Command queue is full')

    def command_servo(self, data):
        axis = data.get('axis')
        if axis not in ('PAN', 'TILT', 'S3'):
            raise ValueError('Unknown servo')
        with self.control, self.lock:
            if self.status != 'connected' or not self.samples:
                raise ValueError('Connect and wait for servo telemetry first')
            latest = self.telemetry if self.binary_active and self.telemetry else self.samples[-1]
            config = latest.get('servos', {}).get(axis)
            if time.time() - latest['received_at'] > 3 or not config or config['ready'] != 1:
                raise ValueError('Servo telemetry is missing, stale, or unavailable')
            if data.get('off') is True:
                command = f'SERVO {axis} OFF\n'
            else:
                if self.servo_inhibit or not self.servo_safety or not self.servo_safety['armed'] or self.servo_safety['estop']:
                    raise ValueError('Servos disabled or E-stop latched; clear E-stop and enable servos first')
                pulse, frequency = data.get('pulse'), data.get('frequency')
                if type(pulse) is not int or type(frequency) is not int:
                    raise ValueError('Pulse width and frequency must be integers')
                if not config['pmin'] <= pulse <= config['pmax'] or not config['fmin'] <= frequency <= config['fmax'] or pulse * frequency >= 1000000:
                    raise ValueError('Command outside firmware servo limits')
                if config.get('mode') == 1 and data.get('continuous') is not True:
                    raise ValueError('Continuous servo requires updated speed/direction controls; refresh dashboard')
                if config.get('mode', 0) != 1 and data.get('continuous') is True:
                    raise ValueError('Servo mode mismatch; wait for fresh mode telemetry')
                manual = data.get('manual') is True
                command = f'SERVO {"RAW " if manual else "CR " if config.get("mode") == 1 else ""}{axis} {pulse} {frequency}\n'
                if not manual and config.get('mode') == 1 and 'speed_limit' in data:
                    limit = data['speed_limit']
                    if type(limit) not in (int, float) or not math.isfinite(limit) or not 0 <= limit <= 360:
                        raise ValueError('Speed limit must be from 0 to 360 deg/s')
                    command = command.rstrip() + f' {limit:g}\n'
            try:
                self.commands.put_nowait(command.encode('ascii'))
            except queue.Full:
                raise ValueError('Command queue is full; wait before sending again')
            self.servo_command_status[axis] = dict(state='queued', queued_at=time.time(), command=command.strip(),
                pulse=data.get('pulse'), frequency=data.get('frequency'), off=data.get('off') is True,
                message='Queued; waiting for connection send')

    def command_safety(self, data):
        action = data.get('action')
        if action not in ('ENABLE', 'DISABLE', 'ESTOP', 'CLEAR'): raise ValueError('Unknown servo safety action')
        with self.control, self.lock:
            if self.status != 'connected': raise ValueError('No board connection; stop command cannot be delivered')
            if action in ('ENABLE', 'CLEAR') and self.safety_command and self.safety_command['state'] in ('queued', 'sent', 'timeout'):
                raise ValueError('Wait for board confirmation of the previous safety action')
            if action == 'ENABLE':
                if not self.servo_safety or time.time() - self.servo_safety['received_at'] > 3:
                    raise ValueError('Wait for fresh servo safety telemetry')
                if self.servo_safety['estop'] or (self.safety_command and self.safety_command['action'] == 'ESTOP' and self.safety_command['state'] != 'applied'):
                    raise ValueError('Clear E-stop before enabling servos')
            if action in ('DISABLE', 'ESTOP', 'CLEAR'):
                self.servo_inhibit = True
                while True:
                    try: self.commands.get_nowait()
                    except queue.Empty: break
                for pending in self.servo_command_status.values():
                    if pending['state'] in ('queued', 'sent', 'timeout'):
                        pending.update(state='cancelled', message='Cancelled by ' + action)
            if self.safety_command and self.safety_command['action'] == 'ESTOP' and self.safety_command['state'] not in ('applied', 'error') and action != 'ESTOP':
                raise ValueError('Wait for board confirmation of E-stop')
            command = f'SERVOS {action}\n'.encode()
            self.safety_command = dict(action=action, state='queued', queued_at=time.time(), message=f'{action} queued; waiting for board confirmation')
            destination = self.priority_commands if action in ('DISABLE', 'ESTOP') else self.commands
            try: destination.put_nowait(command)
            except queue.Full: raise ValueError('Control queue full; reconnect and retry')

    def write_commands(self, write):
        while not self.stop.is_set():
            try:
                command = self.priority_commands.get_nowait()
            except queue.Empty:
                try: command = self.commands.get_nowait()
                except queue.Empty: break
            parts = command.decode().split()
            pending = None
            if parts[0] == 'SERVOS':
                with self.lock:
                    pending = self.safety_command
                    if not pending or pending['action'] != parts[1]: continue
                    if parts[1] in ('ENABLE', 'CLEAR') and time.time() - pending['queued_at'] > 5:
                        pending.update(state='timeout', message='Safety action expired before connection send'); continue
                    pending.update(state='sent', sent_at=time.time(), message=f'{parts[1]} sent; waiting for board confirmation')
            if parts[0] == 'SERVO':
                with self.lock:
                    pending = self.servo_command_status.get(parts[2] if parts[1] in ('CR', 'RAW') else parts[1])
                    if pending and (pending['state'] == 'cancelled' or pending['command'] != command.decode().strip() or time.time() - pending['queued_at'] > 5):
                        if pending['state'] != 'cancelled' and pending['command'] == command.decode().strip():
                            pending.update(state='timeout', message='Relay did not send within 5 seconds; command cancelled. Reconnect and retry.')
                        continue
                    if pending: pending.update(state='sent', sent_at=time.time(), message='Sent; waiting for board acknowledgement')
            try:
                written = write(command)
                if written is not None and written != len(command):
                    raise RuntimeError('Incomplete servo command write; reconnect before retrying')
            except Exception as exc:
                if pending:
                    with self.lock: pending.update(state='error', message='Connection send failed: ' + str(exc))
                raise
            self.log('Sent: ' + command.decode().strip())

    def log(self, line, capture=True):
        with self.lock:
            if capture:
                self.sequence += 1
                self.logs.append({"id": self.sequence, "text": ANSI.sub("", line)[:2000]})
            safety = re.fullmatch(r'Servo safety: ARMED=([01]) ESTOP=([01])', line)
            if safety:
                armed, estop = map(int, safety.groups())
                self.servo_safety = dict(armed=armed, estop=estop, received_at=time.time())
                pending = self.safety_command
                target = dict(ENABLE=(1, 0), DISABLE=(0, None), ESTOP=(0, 1), CLEAR=(0, 0))
                if pending and 'sent_at' in pending:
                    expected = target[pending['action']]
                    if armed == expected[0] and (expected[1] is None or estop == expected[1]):
                        pending.update(state='applied', message='Board confirmed ' + pending['action'])
                        self.servo_inhibit = not bool(armed)
                elif not pending:
                    self.servo_inhibit = not bool(armed)
            match = re.fullmatch(r'Servo ack: (PAN|TILT|S3) PULSE=(\d+) FREQ=(\d+) ENABLE=([01])(?: TARGET=(\d+))?', line)
            if match:
                axis, pulse, frequency, enabled, target = match.groups()
                pending = self.servo_command_status.get(axis)
                if pending and pending['state'] != 'cancelled' and 'sent_at' in pending and ((pending['off'] and enabled == '0') or (not pending['off'] and enabled == '1' and
                    pending['pulse'] == int(target or pulse) and pending['frequency'] == int(frequency))):
                    pending.update(state='applied', message=f'Board confirmed {"OFF" if enabled == "0" else pulse + " µs at " + frequency + " Hz"}')
                    if enabled == '1' and target and target != pulse:
                        pending['message'] = f'Board accepted target {target} µs; output ramping from {pulse} µs'
            elif line.startswith('Servo error:'):
                if self.safety_command and self.safety_command['state'] == 'sent':
                    self.safety_command.update(state='error', message=line)
                for pending in self.servo_command_status.values():
                    if pending['state'] == 'sent': pending.update(state='error', message=line)

    def sample(self, frame):
        if not self.binary_active and frame.get('adc'):
            raw = [value if value is not None else 0 for value in frame['adc']]
            valid = sum(1 << i for i, value in enumerate(frame['adc']) if value is not None)
            self.recorder.feed([(self.sequence, int(frame['device_ms'] * 1000), valid, *raw)], frame['received_at'], frame)
        with self.lock:
            self.telemetry = frame
            if self.binary_active:
                return
            self.sequence += 1
            self.samples.append(dict(frame, id=self.sequence))

    def set_status(self, status, message):
        with self.lock:
            self.status, self.message = status, message

    def effective_config(self):
        """Runtime config snapshot from ATS1 (or empty) plus browser-only notes."""
        with self.lock:
            latest = self.telemetry if self.binary_active and self.telemetry else (self.samples[-1] if self.samples else None)
            board = dict(latest.get('effective_config') or {}) if latest else {}
            pan = dict(latest.get('pan_config') or {}) if latest else {}
            tilt = dict(latest.get('tilt_config') or {}) if latest else {}
            imu = dict(latest.get('tilt_imu') or {}) if latest else {}
        return dict(
            board=board,
            pan_calibration=pan,
            tilt_calibration=tilt,
            tilt_imu=imu,
            sources=dict(
                firmware_headers='src/servo_motion_config.h, pan_calibration.h, tilt_calibration.h, sampling_config.h, network_config.h',
                nvs='PAN settings (pan-settings), TILT pot calibration (tilt-cal); TILT IMU/PID are RAM until reboot',
                browser='channel-scaling.js / localStorage overrides display scaling only; map location in localStorage',
            ),
        )

    def snapshot(self, since=0):
        recording = self.recorder.snapshot()
        dropouts = self.dropouts.snapshot()
        temperature_log = self.temperature_log.snapshot()
        with self.lock:
            if self.safety_command and self.safety_command['state'] in ('queued', 'sent') and time.time() - self.safety_command['queued_at'] > 5:
                self.safety_command.update(state='timeout', message='No board confirmation for ' + self.safety_command['action'] + '; stop state is unconfirmed')
            for pending in self.servo_command_status.values():
                if pending['state'] in ('queued', 'sent') and time.time() - pending['queued_at'] > 5:
                    pending.update(state='timeout', message=('Relay did not send; reconnect and retry.' if pending['state'] == 'queued' else
                        'Sent, but no board acknowledgement. Check the firmware version and reconnect.'))
            received_hz = 0
            now = time.monotonic()
            while self.health_history and self.health_history[0][0] <= now - 10:
                self.health_history.popleft()
            window_seconds = max(.001, min(10, now - self.health_started_at))
            recent_scans = sum(entry[1] for entry in self.health_history)
            recent_gaps = sum(entry[2] for entry in self.health_history)
            recent_bytes = sum(entry[3] for entry in self.health_history)
            if len(self.receipt_history) > 1:
                first, last = self.receipt_history[0], self.receipt_history[-1]
                if last[0] > first[0] and time.monotonic() - last[0] < 1:
                    received_hz = (last[1] - first[1]) / (last[0] - first[0])
            return dict(status=self.status, message=self.message, mode=self.mode,
                        servo_safety=dict(self.servo_safety) if self.servo_safety else None,
                        safety_command=dict(self.safety_command) if self.safety_command else None,
                        servo_inhibit=self.servo_inhibit,
                        servo_commands={axis: dict(value) for axis, value in self.servo_command_status.items()},
                        recording=recording,
                        dropouts=dropouts,
                        temperature=dict(self.temperature) if self.temperature else None,
                        temperature_log=temperature_log,
                        session=self.session, cursor=self.sequence,
                        acquisition=dict(raw_scans=self.raw_scans, sequence_gaps=self.sequence_gaps,
                                         clock_offset=self.adc_time_offset,
                                         received_hz=round(received_hz, 1),
                                         data_age_ms=None if self.last_batch_at is None else round(max(0, now - self.last_batch_at) * 1000, 1),
                                         recent_window_s=round(window_seconds, 2),
                                         received_hz_10s=round(recent_scans / window_seconds, 1),
                                         adc_kbytes_s_10s=round(recent_bytes / window_seconds / 1000, 1),
                                         recent_gaps=recent_gaps,
                                         recent_gap_percent=round(100 * recent_gaps / (recent_scans + recent_gaps), 2) if recent_scans + recent_gaps else 0,
                                         reconnects=max(0, self.tcp_connections - 1),
                                         corrupt_packets=self.corrupt_packets, raw_batches=len(self.raw_batches),
                                         tcp_receive_age_ms=None if self.tcp_last_received is None else round(max(0, now - self.tcp_last_received) * 1000, 1),
                                         tcp_max_receive_gap_ms=round(self.tcp_max_receive_gap_ms, 1),
                                         tcp_max_decode_ms=round(self.tcp_max_decode_ms, 1)),
                        samples=[s for s in self.samples if s["id"] > since],
                        logs=[s for s in self.logs if s["id"] > since],
                        latest=self.samples[-1] if self.samples else None)

    def _disconnect(self):
        self.dropouts.stop()
        self.temperature_log.stop()
        self.stop.set()
        if self.worker:
            self.worker.join(8)
            if self.worker.is_alive():
                raise RuntimeError("Source is still closing. Try Disconnect again shortly.")
            self.worker = None
        while not self.commands.empty():
            try:
                self.commands.get_nowait()
            except queue.Empty:
                break
        self.set_status("disconnected", "Disconnected; captured data is retained until the next connection.")

    def disconnect(self):
        with self.control:
            self._disconnect()

    def connect(self, options):
        mode = options.get("mode")
        if mode not in ("tcp", "remote", "direct", "demo"):
            raise ValueError("Unknown connection mode")
        port = str(options.get("port", "")).strip()
        agent = str(options.get("agent", "desktop-o1gdd79")).strip()
        baud = int(options.get("baud", 115200))
        if not 300 <= baud <= 4000000:
            raise ValueError("Baud must be between 300 and 4000000")
        if mode not in ("demo", "tcp") and (not port or len(port) > 250):
            raise ValueError("Select or enter the serial port first (use Find ports).")
        if mode == "remote" and (not agent or len(agent) > 200):
            raise ValueError("Enter the remote agent name")
        if mode == "tcp":
            host, separator, tcp_port = port.rpartition(':')
            if not separator or not host or len(host) > 200 or not tcp_port.isdigit() or not 1 <= int(tcp_port) <= 65535:
                raise ValueError('Enter ESP address as hostname:port, for example 192.168.20.1:9000')
        with self.control:
            self._disconnect()
            with self.lock:
                self.session += 1
                self.samples.clear()
                self.logs.clear()
                self.mode = mode
                self.raw_batches.clear()
                self.raw_scans = self.sequence_gaps = self.corrupt_packets = 0
                self.receipt_history.clear()
                self.health_history.clear()
                self.last_batch_at = None
                self.temperature = None
                self.health_started_at = time.monotonic()
                self.tcp_connections = 0
                self.tcp_last_received = None
                self.tcp_max_receive_gap_ms = self.tcp_max_decode_ms = 0
                self.last_adc_sequence = self.last_adc_us = self.adc_time_offset = None
                self.telemetry = None
                self.binary_active = False
                self.servo_command_status.clear()
                self.servo_safety = self.safety_command = None
                self.servo_inhibit = True
                while True:
                    try: self.priority_commands.get_nowait()
                    except queue.Empty: break
            self.stop = threading.Event()
            self.dropouts.start(self.session, mode)
            self.temperature_log.start(mode)
            self.set_status("connecting", "Opening " + ("simulated data" if mode == "demo" else port))
            self.worker = threading.Thread(target=self._run, args=(mode, agent, port, baud), daemon=True)
            self.worker.start()

    def _run(self, mode, agent, port, baud):
        parser = Parser(self.sample)
        last_raw_frame = 0
        capture_frame = True

        def line(text):
            nonlocal last_raw_frame, capture_frame
            if text.startswith('Time ms:'):
                now = time.monotonic()
                capture_frame = now - last_raw_frame >= 1
                if capture_frame: last_raw_frame = now
            routine = not text or text.startswith(('Time ms:', 'ADC raw', 'ADC mode:', 'Rates:', 'Link health:',
                'Ranges:', 'GPIO states:', 'Servo safety:', 'Servo PAN:', 'Servo TILT:', 'Servo S3:',
                'Accel g ', 'Gyro dps ', 'Mag uT ', 'Chip temperature:', 'Motion ', 'Tilt config:', 'Pan config:', 'Tilt IMU:'))
            # Process EVERY status/acknowledgement; sample only the raw text log.
            self.log(text, capture=not routine or capture_frame)
            if text.startswith('Chip temperature:'):
                self.temperature_line(text)
                return
            parser.line(text)

        lines = Stream(line, self.adc_batch, self.corrupt_packet, self.status_frame)
        try:
            if mode == "demo":
                servo_states = {axis: dict(gpio=pin, pmin=500, pcenter=1500, pmax=2500,
                                          umin=1400 if axis != 'S3' else 500, ucenter=1500, umax=1600 if axis != 'S3' else 2500,
                                          mode=0 if axis == 'S3' else 1, neutral=1500 if axis != 'S3' else 0,
                                          fmin=50, fcenter=50, fmax=50, pulse=1500, freq=50, enable=0, ready=1)
                                for axis, pin in [('PAN', 1), ('TILT', 2), ('S3', 3)]}
                ranges = dict(accel=8, gyro=2000, mag=2000, ready=1)
                safety = dict(armed=0, estop=0)
                adc_mode = dict(channel=-1, spi=16000000)
                demo_tilt = dict(vmin=.004, vmax=3.3, zero=0, amin=0, amax=360, volts=1.652,
                                 sweep=0, smin=math.nan, smax=math.nan, progress=0, reason=0, cap=300, minpwm=42, rotations=1)
                def demo_write(command):
                    parts = command.decode().split()
                    if parts[0] == 'TILT':
                        if parts[1] == 'CONFIG':
                            servo_states['TILT']['enable'] = 0
                            demo_tilt.update(zip(('vmin', 'vmax', 'zero', 'amin', 'amax'), map(float, parts[2:])))
                        elif parts[1] == 'ZERO':
                            servo_states['TILT']['enable'] = 0
                            demo_tilt['zero'] = (demo_tilt['volts'] - demo_tilt['vmin']) * 360 / (demo_tilt['vmax'] - demo_tilt['vmin'])
                        elif parts[1:3] == ['SWEEP', 'START']:
                            demo_tilt.update(sweep=1, progress=0, smin=.004, smax=3.3, reason=0, cap=float(parts[5]) if len(parts) > 5 else 300, minpwm=float(parts[7]) if len(parts) > 7 else 42, rotations=int(parts[8]) if len(parts) > 8 else 1)
                        elif parts[1:3] == ['SWEEP', 'STOP']:
                            demo_tilt['sweep'] = 3; servo_states['TILT']['enable'] = 0
                        elif parts[1:3] == ['SWEEP', 'APPLY']:
                            demo_tilt.update(vmin=demo_tilt['smin'], vmax=demo_tilt['smax'])
                        return len(command)
                    if parts[0] == 'ADC':
                        adc_mode.update(channel=-1 if parts[2] == 'ALL' else int(parts[2]), spi=16000000)
                        return len(command)
                    if parts[0] == 'SERVOS':
                        action = parts[1]
                        if action == 'ENABLE' and safety['estop']:
                            line('Servo error: E-stop latched'); return len(command)
                        safety['armed'] = int(action == 'ENABLE')
                        if action == 'ESTOP': safety['estop'] = 1
                        if action == 'CLEAR': safety['estop'] = 0
                        if not safety['armed']:
                            for servo in servo_states.values(): servo['enable'] = 0
                            if demo_tilt['sweep'] == 1: demo_tilt['sweep'] = 3
                        line(f"Servo safety: ARMED={safety['armed']} ESTOP={safety['estop']}")
                        return len(command)
                    if parts[0] == 'RANGE':
                        ranges.update(accel=int(parts[1]), gyro=int(parts[2]))
                        return len(command)
                    if parts[:2] == ['SERVO', 'SPEED']:
                        demo_speeds[parts[2]] = float(parts[3])
                        line('Servo speed setting applied'); return len(command)
                    if parts[:2] == ['SERVO', 'OVERSPEED']:
                        demo_overspeed[parts[2]] = int(parts[3])
                        line('Servo overspeed fault setting applied'); return len(command)
                    if parts[:2] == ['SERVO', 'CR']: parts.pop(1)
                    servo = servo_states[parts[1]]
                    if parts[2] != 'OFF' and (not safety['armed'] or safety['estop']):
                        line('Servo error: servos disabled or E-stop latched'); return len(command)
                    if parts[2] == 'OFF':
                        servo['enable'] = 0
                        if parts[1] == 'TILT' and demo_tilt['sweep'] == 1: demo_tilt['sweep'] = 3
                    else:
                        servo.update(pulse=int(parts[2]), freq=int(parts[3]), enable=1)
                        if len(parts) == 5: demo_speeds[parts[1]] = float(parts[4])
                    line(f"Servo ack: {parts[1]} PULSE={servo['pulse']} FREQ={servo['freq']} ENABLE={servo['enable']}")
                    return len(command)
                self.set_status("connected", "DEMO — simulated sensor readings")
                demo_speeds = {'PAN': 30, 'TILT': 30}
                demo_overspeed = {'PAN': 1, 'TILT': 1}
                start = time.monotonic()
                while not self.stop.is_set():
                    self.write_commands(demo_write)
                    t = time.monotonic() - start
                    line(f"Time ms: {int(t * 1000)}")
                    line("ADC raw (0..4095): " + " ".join(
                        f"CH{i}={int(2048 + 1700 * math.sin(t * .8 + i * .4)) if adc_mode['channel'] in (-1, i) else 'ERR'}" for i in range(16)))
                    line(f"ADC mode: CHANNEL={adc_mode['channel']} SPI={adc_mode['spi']}")
                    line(f"Accel g (x,y,z): {math.sin(t)*.1}, {math.cos(t)*.1}, 1.0")
                    line(f"Gyro dps (x,y,z): {math.sin(t)*15}, {math.cos(t)*10}, {math.sin(t*.5)*8}")
                    line(f"Mag uT (x,y,z): {25+math.sin(t)*3}, {-8+math.cos(t)*3}, 42.0")
                    line("GPIO states: GPIO46=1 " + " ".join(
                        f"GPIO{pin}={int(t * 2 + phase) % 2}" for phase, pin in enumerate((4, 13, 14))))
                    for axis, values in servo_states.items():
                        line(f'Servo {axis}: ' + ' '.join(f'{key.upper()}={value}' for key, value in values.items()))
                        if axis in demo_speeds:
                            line(f"Motion {axis}: ANGLE={(values['pulse'] - 500) * .18} SPEED=0 LIMIT={demo_speeds[axis]} TARGET={values['pulse']} MOVING=0 MINANGLE=0 MAXANGLE=360 OSFAULT={demo_overspeed[axis]}")
                            offset = values['pulse'] - values['neutral'] if values['enable'] else 0
                            line(f"PID {axis}: SETPOINT=0 ERROR=0 P=0 I=0 D=0 FF={offset} STARTUP=0 REQUEST={offset} OUTPUT={offset} ACTIVE={int(bool(values['enable']) and demo_speeds[axis] > 0)}")
                    if demo_tilt['sweep'] == 1:
                        demo_tilt['progress'] += 30
                        if demo_tilt['progress'] >= 360 * demo_tilt['rotations']: demo_tilt['sweep'] = 2
                    line('Tilt config: ' + ' '.join(f'{key.upper()}={value}' for key, value in demo_tilt.items()))
                    line('Ranges: ' + ' '.join(f'{key.upper()}={value}' for key, value in ranges.items()))
                    line(f"Servo safety: ARMED={safety['armed']} ESTOP={safety['estop']}")
                    line("")
                    self.stop.wait(.2)
            elif mode == "tcp":
                self._remote(agent, port, baud, lines, tcp=True)
            elif mode == "direct":
                try:
                    import serial
                except ImportError as exc:
                    raise RuntimeError("Install dashboard/requirements.txt or use start-dashboard.ps1.") from exc
                device = serial.Serial(port=None, baudrate=baud, timeout=.25)
                device.port = port
                device.dtr = True  # USB CDC Serial requires an open-terminal indication.
                device.rts = False
                with device:
                    self.set_status("connected", f"USB serial · {port} · {baud} baud")
                    while not self.stop.is_set():
                        self.write_commands(device.write)
                        lines.feed(device.read(min(device.in_waiting or 1, 4096)))
            else:
                self._remote(agent, port, baud, lines)
        except Exception as exc:
            if not self.stop.is_set():
                self.log(str(exc))
                self.set_status("error", str(exc))
        finally:
            parser.flush()

    def _remote(self, agent, port, baud, lines, tcp=False):
        failures = 0
        tcp_connected_once = False
        while not self.stop.is_set():
            self.remote_connected_at = None
            try:
                if tcp: self._tcp_once(port, lines)
                else: self._remote_once(agent, port, baud, lines)
                return
            except (OSError, RuntimeError) as exc:
                if self.stop.is_set(): return
                if tcp and self.remote_connected_at is not None:
                    tcp_connected_once = True
                if self.remote_connected_at and time.monotonic() - self.remote_connected_at >= 10:
                    failures = 0
                self.log(str(exc))
                # Never replay movement or stale configuration commands after a
                # broken connection. Existing physical output state is unknown.
                with self.lock:
                    self.servo_inhibit = True
                    self.servo_safety = None
                    self.telemetry = None
                    if self.safety_command and self.safety_command['state'] in ('queued', 'sent'):
                        self.safety_command.update(state='error', message='Connection lost; output state unconfirmed')
                    for pending in self.servo_command_status.values():
                        if pending['state'] in ('queued', 'sent', 'timeout'):
                            pending.update(state='cancelled', message='Connection lost; command cancelled; output state unconfirmed')
                    for pending_queue in (self.commands, self.priority_commands):
                        while True:
                            try: pending_queue.get_nowait()
                            except queue.Empty: break
                lines.pending.clear()
                if tcp_connected_once:
                    self.set_status('connecting', f'TCP interrupted; reconnecting in {TCP_RECONNECT_SECONDS}s. {exc}')
                    if self.stop.wait(TCP_RECONNECT_SECONDS): return
                    continue
                if failures >= len(REMOTE_RETRY_DELAYS):
                    raise RuntimeError(f'{"TCP" if tcp else "Remote"} reconnect attempts exhausted: {exc}') from exc
                delay = REMOTE_RETRY_DELAYS[failures]
                failures += 1
                self.set_status('connecting', f'{"TCP" if tcp else "Remote"} interrupted; reconnecting in {delay}s ({failures}/{len(REMOTE_RETRY_DELAYS)}). {exc}')
                if self.stop.wait(delay): return

    def _tcp_once(self, endpoint, lines):
        host, _, port = endpoint.rpartition(':')
        self.log('Connecting TCP telemetry to ' + endpoint)
        with socket.create_connection((host, int(port)), timeout=3) as connection:
            # Let Windows absorb incoming bursts while Python processes a frame
            # or services the browser, instead of advertising a tiny TCP window.
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            connection.settimeout(.25)
            self.remote_connected_at = time.monotonic()
            with self.lock:
                self.tcp_connections += 1
                self.tcp_last_received = None
            self.set_status('connected', 'TCP · ' + endpoint)
            last_received = time.monotonic()
            while not self.stop.is_set():
                self.write_commands(connection.sendall)
                try: chunk = connection.recv(65536)
                except socket.timeout:
                    if time.monotonic() - last_received >= 10:
                        raise RuntimeError('No TCP telemetry for 10 seconds; connection unresponsive')
                    continue
                if not chunk: raise RuntimeError('ESP TCP connection closed')
                received_at = time.monotonic()
                with self.lock:
                    if self.tcp_last_received is not None:
                        self.tcp_max_receive_gap_ms = max(self.tcp_max_receive_gap_ms, (received_at - last_received) * 1000)
                    self.tcp_last_received = received_at
                last_received = received_at
                lines.feed(chunk)
                with self.lock:
                    self.tcp_max_decode_ms = max(self.tcp_max_decode_ms, (time.monotonic() - received_at) * 1000)

    def _remote_once(self, agent, port, baud, lines):
        with tempfile.TemporaryDirectory(prefix="antenna-monitor-") as directory:
            command = remote_command(agent, port, baud, directory)
            self.log("Starting remote bridge for " + agent + ":" + port)
            env = dict(os.environ, PYTHONUNBUFFERED="1", NO_COLOR="1")
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, env=env, **process_options())
            diagnostics_log = deque(maxlen=8)

            def diagnostics():
                for raw in iter(process.stdout.readline, b""):
                    message = ANSI.sub('', raw.decode("utf-8", errors="replace").rstrip())
                    diagnostics_log.append(message)
                    self.log(message)

            reader = threading.Thread(target=diagnostics, daemon=True)
            reader.start()
            try:
                path = Path(directory) / "sock"
                deadline = time.monotonic() + 40
                address = None
                while not self.stop.wait(.1):
                    if path.exists():
                        match = re.fullmatch(r"socket://localhost:(\d+)", path.read_text().strip())
                        if match:
                            address = ("127.0.0.1", int(match[1]))
                            break
                    if process.poll() is not None:
                        raise RuntimeError("Remote monitor exited. Check the raw log, agent name and PlatformIO login.")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Remote connection timed out. Check agent availability, port and login.")
                if address is None:
                    return
                with socket.create_connection(address, timeout=2) as bridge:
                    bridge.settimeout(.25)
                    self.remote_connected_at = time.monotonic()
                    self.set_status("connected", f"Remote · {agent} · {port} · {baud} baud")
                    while not self.stop.is_set():
                        self.write_commands(bridge.sendall)
                        try:
                            chunk = bridge.recv(4096)
                        except socket.timeout:
                            if process.poll() is not None:
                                raise RuntimeError("Remote monitor stopped")
                            continue
                        if not chunk:
                            raise RuntimeError("Remote connection closed")
                        lines.feed(chunk)
            except (OSError, RuntimeError) as exc:
                # Let the diagnostics reader collect the subprocess's exit reason.
                if process.poll() is not None: reader.join(.5)
                details = ' | '.join(line for line in tuple(diagnostics_log) if line and not line.startswith('Starting Serial Monitor'))
                if 'A device attached to the system is not functioning' in details:
                    raise RuntimeError('Remote USB serial device failed while configuring the port. '
                                       'Reconnect the board USB cable on the agent computer, then rediscover its COM port. ' + details) from exc
                if 'Access is denied' in details:
                    raise RuntimeError('Remote COM port is busy; close its other serial monitor. ' + details) from exc
                raise RuntimeError(str(exc) + (': ' + details if details else '')) from exc
            finally:
                # Closing the bridge lets PlatformIO release the remote serial port.
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=2)
                reader.join(1)
                process.stdout.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, code=200):
        body = json.dumps(value, allow_nan=False).encode()
        self.send_bytes(body, "application/json", code)

    def send_bytes(self, body, content_type, code=200):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def local_request(self):
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        bind_host = self.server.server_address[0]
        if bind_host not in ("0.0.0.0", "::"):
            allowed.add(f"{bind_host}:{self.server.server_port}")
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in allowed and (origin is None or origin == "http://" + host)

    def do_GET(self):
        if not self.local_request():
            return self.reply({"error": "Local requests only"}, 403)
        url = urlsplit(self.path)
        if url.path == "/api/state":
            try:
                since = int(parse_qs(url.query).get("since", ["0"])[0])
                return self.reply(self.server.relay.snapshot(since))
            except ValueError:
                return self.reply({"error": "Invalid cursor"}, 400)
        if url.path == "/api/config":
            return self.reply(self.server.relay.effective_config())
        if url.path == '/api/adc-export':
            with self.server.relay.lock:
                body = b''.join(self.server.relay.raw_batches)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename="adc-scans.atb"')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == '/api/dropouts/events':
            return self.reply(self.server.relay.dropouts.recent_events())
        if url.path in ('/api/dropouts/download', '/api/temperature/download'):
            try:
                logger = self.server.relay.dropouts if url.path == '/api/dropouts/download' else self.server.relay.temperature_log
                filename, body = logger.download()
            except ValueError as exc:
                return self.reply({'error': str(exc)}, 404)
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv; charset=utf-8')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == '/api/recording/download':
            filename = parse_qs(url.query).get('file', [''])[0]
            if not re.fullmatch(r'telemetry-\d{8}-\d{6}-\d{6}\.csv', filename):
                return self.reply({'error': 'Invalid recording filename'}, 400)
            path = ROOT / 'recordings' / filename
            if not path.is_file(): return self.reply({'error': 'Recording not found'}, 404)
            state = self.server.relay.recorder.snapshot()
            if (state['active'] or state['finishing']) and self.server.relay.recorder.path == path:
                return self.reply({'error': 'Stop recording before downloading'}, 409)
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv; charset=utf-8')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_header('Content-Length', str(path.stat().st_size))
            self.end_headers()
            with path.open('rb') as source: shutil.copyfileobj(source, self.wfile)
            return
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/device-map.js": ("device-map.js", "text/javascript; charset=utf-8"),
                 "/vendor/leaflet/leaflet.js": ("vendor/leaflet/leaflet.js", "text/javascript; charset=utf-8"),
                 "/vendor/leaflet/leaflet.css": ("vendor/leaflet/leaflet.css", "text/css; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/orientation.js": ("orientation.js", "text/javascript; charset=utf-8"),
                 "/channel-scaling.js": ("channel-scaling.js", "text/javascript; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8")}
        if url.path not in files:
            return self.reply({"error": "Not found"}, 404)
        name, mime = files[url.path]
        self.send_bytes((ROOT / name).read_bytes(), mime)

    def do_POST(self):
        if not self.local_request() or self.headers.get("Content-Type") != "application/json":
            return self.reply({"error": "Expected a same-origin JSON request"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("Invalid request length")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Expected an object")
            if self.path == "/api/connect":
                self.server.relay.connect(data)
                self.reply({"ok": True})
            elif self.path == "/api/disconnect":
                self.server.relay.disconnect()
                self.reply({"ok": True})
            elif self.path == "/api/ports":
                self.reply({"ports": list_ports(str(data.get("mode", "")), str(data.get("agent", "")))})
            elif self.path == '/api/servo':
                self.server.relay.command_servo(data)
                self.reply({'ok': True, 'message': 'Command queued; watch reported output for confirmation.'})
            elif self.path == '/api/servo-safety':
                self.server.relay.command_safety(data)
                self.reply({'ok': True, 'message': 'Waiting for board confirmation'})
            elif self.path == '/api/servo-speed':
                self.server.relay.command_servo_speed(data)
                self.reply({'ok': True})
            elif self.path == '/api/pan':
                self.server.relay.command_pan(data)
                self.reply({'ok': True})
            elif self.path == '/api/servo-position':
                self.server.relay.command_servo_position(data)
                self.reply({'ok': True})
            elif self.path == '/api/servo-ramp':
                self.server.relay.command_servo_position(data, gains='ramp')
                self.reply({'ok': True})
            elif self.path == '/api/servo-deadband':
                self.server.relay.command_servo_position(data, gains='deadband')
                self.reply({'ok': True})
            elif self.path == '/api/servo-pid':
                self.server.relay.command_servo_position(data, gains=True)
                self.reply({'ok': True})
            elif self.path == '/api/servo-overspeed':
                self.server.relay.command_servo_overspeed(data)
                self.reply({'ok': True})
            elif self.path == '/api/servo-pwm-sweep':
                self.server.relay.command_servo_pwm_sweep(data)
                self.reply({'ok': True})
            elif self.path == '/api/servo-pwm-slew':
                self.server.relay.command_servo_pwm_slew(data)
                self.reply({'ok': True})
            elif self.path == '/api/tilt-imu':
                self.server.relay.command_tilt_imu(data)
                self.reply({'ok': True})
            elif self.path == '/api/tilt':
                self.server.relay.command_tilt(data)
                self.reply({'ok': True})
            elif self.path == '/api/ranges':
                self.server.relay.command_ranges(data)
                self.reply({'ok': True, 'message': 'Range change queued; watch reported ranges.'})
            elif self.path == '/api/adc-channel':
                self.server.relay.command_adc_channel(data)
            elif self.path == '/api/adc-stream':
                self.server.relay.command_adc_stream(data)
                self.reply({'ok': True, 'message': 'ADC stream setting queued; reconnect if status freezes after lean.'})
            elif self.path == '/api/recording/start':
                self.reply(self.server.relay.recorder.start(data.get('scaling')))
            elif self.path == '/api/recording/stop':
                self.reply(self.server.relay.recorder.stop())
            else:
                self.reply({"error": "Not found"}, 404)
        except (ValueError, TypeError) as exc:
            self.reply({"error": str(exc)}, 400)
        except Exception as exc:
            self.reply({"error": str(exc)}, 500)


class DashboardServer(ThreadingHTTPServer):
    def service_actions(self):
        # Detect sustained outages even with the browser closed or asleep.
        self.relay.dropouts.tick()


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--port", type=int, default=8765, help="Local HTTP port (default: 8765)")
    args.add_argument("--no-browser", action="store_true")
    args.add_argument("--host", default="127.0.0.1", help="Bind address; use the PC hotspot IP for a shared live viewer")
    options = args.parse_args()
    server = DashboardServer((options.host, options.port), Handler)
    server.relay = Relay()
    url = f"http://{options.host}:{server.server_port}"
    print("Sensor dashboard: " + url + " (Ctrl+C to stop)", flush=True)
    if not options.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=.05)
    except KeyboardInterrupt:
        pass
    finally:
        server.relay.disconnect()
        server.relay.recorder.stop()
        server.server_close()


if __name__ == "__main__":
    main()
