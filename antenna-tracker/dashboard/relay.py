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

ROOT = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
VECTOR = re.compile(r"^(Accel g|Gyro dps|Mag uT) \(x,y,z\):\s*(.*)$")
REMOTE_RETRY_DELAYS = (1, 2, 4)


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
            elif line.startswith('Servo error:'):
                self.frame['errors'].append(line)
            elif line.startswith('Sensor error:'):
                self.frame['errors'].append(line)
            elif line.startswith('Rates:'):
                self.frame['rates'] = {key.lower(): float(value) for key, value in re.findall(r'([A-Z]+)=([\d.]+)', line)}
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
        self.last_adc_sequence = self.last_adc_us = self.adc_time_offset = None
        self.telemetry = None
        self.binary_active = False
        self.recorder = Recorder(ROOT / 'recordings')

    def corrupt_packet(self):
        with self.lock:
            self.corrupt_packets += 1

    def adc_batch(self, records, packet):
        received = time.time()
        with self.lock:
            metadata = dict(self.telemetry or {})
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
            for sequence, stamp, valid, *raw in records:
                reboot = self.last_adc_us is not None and stamp < self.last_adc_us
                if reboot or self.adc_time_offset is None:
                    self.adc_time_offset = received - records[-1][1] / 1e6
                if self.last_adc_sequence is not None and not reboot:
                    gap = (sequence - self.last_adc_sequence - 1) & 0xFFFFFFFF
                    self.sequence_gaps += gap
                self.last_adc_sequence, self.last_adc_us = sequence, stamp
                for channel, value in enumerate(raw):
                    if valid & (1 << channel) and value <= 4095:
                        columns[channel].append(value)
            self.raw_scans += len(records)
            receipt_time = time.monotonic()
            self.receipt_history.append((receipt_time, self.raw_scans))
            while len(self.receipt_history) > 2 and self.receipt_history[1][0] < receipt_time - 2:
                self.receipt_history.popleft()
            sequence, stamp, valid, *raw = records[-1]
            frame = dict(self.telemetry or dict(accel=None, gyro=None, mag=None, gpio={}, servos={}, errors=[]))
            frame.update(device_ms=stamp / 1000, device_us=stamp, adc_sequence=sequence,
                         sensor_device_ms=metadata.get('device_ms'),
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
                command = f'SERVO {axis} {pulse} {frequency}\n'
            try:
                self.commands.put_nowait(command.encode('ascii'))
            except queue.Full:
                raise ValueError('Command queue is full; wait before sending again')
            self.servo_command_status[axis] = dict(state='queued', queued_at=time.time(), command=command.strip(),
                pulse=data.get('pulse'), frequency=data.get('frequency'), off=data.get('off') is True,
                message='Queued in relay; waiting for serial send')

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
                        pending.update(state='timeout', message='Safety action expired before serial send'); continue
                    pending.update(state='sent', sent_at=time.time(), message=f'{parts[1]} sent; waiting for board confirmation')
            if parts[0] == 'SERVO':
                with self.lock:
                    pending = self.servo_command_status.get(parts[1])
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
                    with self.lock: pending.update(state='error', message='Serial send failed: ' + str(exc))
                raise
            self.log('Sent: ' + command.decode().strip())

    def log(self, line):
        with self.lock:
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
            match = re.fullmatch(r'Servo ack: (PAN|TILT|S3) PULSE=(\d+) FREQ=(\d+) ENABLE=([01])', line)
            if match:
                axis, pulse, frequency, enabled = match.groups()
                pending = self.servo_command_status.get(axis)
                if pending and pending['state'] != 'cancelled' and 'sent_at' in pending and ((pending['off'] and enabled == '0') or (not pending['off'] and enabled == '1' and
                    pending['pulse'] == int(pulse) and pending['frequency'] == int(frequency))):
                    pending.update(state='applied', message=f'Board confirmed {"OFF" if enabled == "0" else pulse + " µs at " + frequency + " Hz"}')
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

    def snapshot(self, since=0):
        recording = self.recorder.snapshot()
        with self.lock:
            if self.safety_command and self.safety_command['state'] in ('queued', 'sent') and time.time() - self.safety_command['queued_at'] > 5:
                self.safety_command.update(state='timeout', message='No board confirmation for ' + self.safety_command['action'] + '; stop state is unconfirmed')
            for pending in self.servo_command_status.values():
                if pending['state'] in ('queued', 'sent') and time.time() - pending['queued_at'] > 5:
                    pending.update(state='timeout', message=('No serial send from relay; reconnect and retry.' if pending['state'] == 'queued' else
                        'Sent, but no board acknowledgement. Check the firmware version and reconnect.'))
            received_hz = 0
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
                        session=self.session, cursor=self.sequence,
                        acquisition=dict(raw_scans=self.raw_scans, sequence_gaps=self.sequence_gaps,
                                         clock_offset=self.adc_time_offset,
                                         received_hz=round(received_hz, 1),
                                         corrupt_packets=self.corrupt_packets, raw_batches=len(self.raw_batches)),
                        samples=[s for s in self.samples if s["id"] > since],
                        logs=[s for s in self.logs if s["id"] > since],
                        latest=self.samples[-1] if self.samples else None)

    def _disconnect(self):
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
        if mode not in ("remote", "direct", "demo"):
            raise ValueError("Unknown connection mode")
        port = str(options.get("port", "")).strip()
        agent = str(options.get("agent", "desktop-o1gdd79")).strip()
        baud = int(options.get("baud", 115200))
        if not 300 <= baud <= 4000000:
            raise ValueError("Baud must be between 300 and 4000000")
        if mode != "demo" and (not port or len(port) > 250):
            raise ValueError("Select or enter the serial port first (use Find ports).")
        if mode == "remote" and (not agent or len(agent) > 200):
            raise ValueError("Enter the remote agent name")
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
            self.set_status("connecting", "Opening " + ("simulated data" if mode == "demo" else port))
            self.worker = threading.Thread(target=self._run, args=(mode, agent, port, baud), daemon=True)
            self.worker.start()

    def _run(self, mode, agent, port, baud):
        parser = Parser(self.sample)

        def line(text):
            self.log(text)
            parser.line(text)

        lines = Stream(line, self.adc_batch, self.corrupt_packet)
        try:
            if mode == "demo":
                servo_states = {axis: dict(gpio=pin, pmin=500, pcenter=1500, pmax=2500,
                                          umin=500, ucenter=2400 if axis == 'TILT' else 1500, umax=2500,
                                          fmin=50, fcenter=50, fmax=50, pulse=1500, freq=50, enable=0, ready=1)
                                for axis, pin in [('PAN', 1), ('TILT', 2), ('S3', 3)]}
                ranges = dict(accel=8, gyro=2000, mag=2000, ready=1)
                safety = dict(armed=0, estop=0)
                adc_mode = dict(channel=-1, spi=16000000)
                def demo_write(command):
                    parts = command.decode().split()
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
                        line(f"Servo safety: ARMED={safety['armed']} ESTOP={safety['estop']}")
                        return len(command)
                    if parts[0] == 'RANGE':
                        ranges.update(accel=int(parts[1]), gyro=int(parts[2]))
                        return len(command)
                    servo = servo_states[parts[1]]
                    if parts[2] != 'OFF' and (not safety['armed'] or safety['estop']):
                        line('Servo error: servos disabled or E-stop latched'); return len(command)
                    if parts[2] == 'OFF':
                        servo['enable'] = 0
                    else:
                        servo.update(pulse=int(parts[2]), freq=int(parts[3]), enable=1)
                    line(f"Servo ack: {parts[1]} PULSE={servo['pulse']} FREQ={servo['freq']} ENABLE={servo['enable']}")
                    return len(command)
                self.set_status("connected", "DEMO — simulated sensor readings")
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
                    line('Ranges: ' + ' '.join(f'{key.upper()}={value}' for key, value in ranges.items()))
                    line(f"Servo safety: ARMED={safety['armed']} ESTOP={safety['estop']}")
                    line("")
                    self.stop.wait(.2)
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

    def _remote(self, agent, port, baud, lines):
        failures = 0
        while not self.stop.is_set():
            self.remote_connected_at = None
            try:
                self._remote_once(agent, port, baud, lines)
                return
            except (OSError, RuntimeError) as exc:
                if self.stop.is_set(): return
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
                if failures >= len(REMOTE_RETRY_DELAYS):
                    raise RuntimeError(f'Remote reconnect attempts exhausted: {exc}') from exc
                delay = REMOTE_RETRY_DELAYS[failures]
                failures += 1
                self.set_status('connecting', f'Remote interrupted; reconnecting in {delay}s ({failures}/{len(REMOTE_RETRY_DELAYS)}). {exc}')
                if self.stop.wait(delay): return

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
                if 'Access is denied' in details or 'PermissionError' in details:
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
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def local_request(self):
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
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
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
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
            elif self.path == '/api/ranges':
                self.server.relay.command_ranges(data)
                self.reply({'ok': True, 'message': 'Range change queued; watch reported ranges.'})
            elif self.path == '/api/adc-channel':
                self.server.relay.command_adc_channel(data)
                self.reply({'ok': True, 'message': 'ADC selection queued; waiting for board confirmation.'})
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


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--port", type=int, default=8765, help="Local HTTP port (default: 8765)")
    args.add_argument("--no-browser", action="store_true")
    options = args.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", options.port), Handler)
    server.relay = Relay()
    url = f"http://127.0.0.1:{server.server_port}"
    print("Sensor dashboard: " + url + " (Ctrl+C to stop)", flush=True)
    if not options.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.relay.disconnect()
        server.relay.recorder.stop()
        server.server_close()


if __name__ == "__main__":
    main()
