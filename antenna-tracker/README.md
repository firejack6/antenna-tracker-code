# Wi-Fi TCP connection

Firmware now sends ADC binary batches (**ATB2**), compact binary status (**ATS1**),
and text control acknowledgements/errors over Wi-Fi TCP. USB prints
startup/network diagnostics only; PlatformIO Remote is needed only for uploading,
not for dashboard telemetry.

## Configuration sources of truth

| Kind | Where it lives | Survives reboot? |
| --- | --- | --- |
| Compile-time defaults | `src/*_config.h`, `pan_calibration.h`, `tilt_calibration.h` | N/A (flash image) |
| PAN calibration + PID/deadband/ramp/speed | ESP NVS `pan-settings` via Save PAN | Yes |
| TILT pot mapping / angle limits | ESP NVS `tilt-cal` | Yes |
| TILT IMU map / TILT position PID | RAM (Apply in UI) | No — resets to headers |
| ADC channel display scaling | `dashboard/channel-scaling.js` + browser `localStorage` | Browser only |
| Map / UI prefs | browser `localStorage` | Browser only |

`GET /api/config` returns the latest board `effective_config` from ATS1 plus these source notes.

0. One-time local secrets: from `antenna-tracker/` run `python setup_env.py`
   (writes gitignored `.env` and applies Wi-Fi / OpenSky / site / ADS-B defaults).
   Or copy `.env.example` → `.env` and run `python setup_env.py --apply`.
1. Upload the firmware to the Nano ESP32.
2. Start `start-dashboard.ps1`; it asks Windows to join **antenna-tracker** using
   the name/password in `src/network_config.h`, then opens the dashboard.
3. If Windows rejects the Wi-Fi request, join the hotspot manually using the
   password you set in `src/network_config.h` (`WIFI_PASSWORD`). The launcher
   prints the Windows error and still starts.
4. Select **Wi-Fi TCP**, enter **192.168.20.1:9000**, then Connect.

Edit `src/network_config.h` for the Wi-Fi name/password, TCP port and network
mode. To join an existing router, set `WIFI_ACCESS_POINT = false` and enter
that router's SSID/password. Connect the PC to the same network and use the
ESP IP address printed on USB at startup, followed by `:9000`.

The launcher installs a Wi-Fi profile for the current Windows user and explicitly
connects on each launch. Use `./start-dashboard.ps1 -SkipWifi` to keep your current
network, or `-WifiInterface 'Wi-Fi'` to select an adapter if you have several.
It skips hotspot setup when `WIFI_ACCESS_POINT = false`. Windows may require
location permission for Wi-Fi operations; if it reports access denied, enable
Location services and desktop app location access in Windows Settings.

The dashboard preserves plotting, full-rate CSV, channel scaling and controls.
The same timestamped, CRC-checked ADC packets are used over TCP. Network
interruptions after a successful TCP connection trigger reconnects every five
seconds until Disconnect is clicked. Initial connection failures use bounded
retries. Queued controls and partial commands
are discarded across connections. Servos remain disabled at boot. Only one
TCP dashboard client is accepted at a time.

ADC buffering holds 4,096 records in PSRAM (about 0.4 seconds at 10 kHz),
with a 2,048-record internal-RAM fallback if PSRAM is unavailable. Status text
is batched into a single TCP write. Partially sent output stays in an owned send
queue and retries without blocking inbound controls. Temporary 500 ms stalls no
longer force a reconnect; the connection closes on socket errors or five seconds
without send progress (`TCP_NO_PROGRESS_TIMEOUT_MS` in `src/network_config.h`).
Longer network
pauses can cause counted buffer drops; TCP does not eliminate acquisition or
buffer overruns. The configured ADC rate is a target, not a measured guarantee.
The TCP writer runs above I2C polling priority and drains up to four ADC batches
per pass (an 8 ms catch-up budget, apart from a blocked network write). ADC and
TCP tasks copy ring payloads outside their shared lock. When full, the ring drops
incoming records instead of overwriting unread ones; live channel values still
update. `buffer drops` counts those discarded records. `missed ticks` counts
missed acquisition bursts, and `received gaps` includes both missed sampling and
lost records. `max burst` measures an entire acquisition burst, not one scan.
The raw monitor samples routine telemetry once per second and only redraws
when new log entries arrive. **Pause monitor** freezes its display while live
plots, control acknowledgements and CSV recording continue.

The connection health panel shows time since the last valid ADC batch, a rolling
10-second ADC receive rate and byte rate, recent sequence gaps, estimated ESP
buffer delay, TCP stalls/failed writes, longest write and session reconnects.
Recent gaps include acquisition misses and discarded data, not Wi-Fi packet loss.
ESP counters are cumulative since boot; buffer values are last reported telemetry.
TCP health also reports pending output bytes and the last close reason: peer
disconnect, socket error, no-progress timeout, queue overflow or Wi-Fi unavailable.

For overnight tests, every gap **over 100 ms between valid ADC batch deliveries**
counts as one dropout. The relay logs onset and recovery (with UTC timestamps and
duration) to `dashboard/health-logs/dropouts-*.csv`, automatically and independently
of full-rate CSV recording. Download the current log from the health panel.
An outage is counted while still ongoing; a permanent disconnect is not missed.
Monitoring begins with the first ADC batch, continues across automatic reconnects
and with the browser closed, and stops on deliberate Disconnect/relay shutdown.
A new Connect starts a fresh counter/file; old files remain on disk. Keep Windows
and the relay awake overnight. A `started` row without a recovery row indicates
an unfinished outage (for example a process crash). File errors appear in the UI.
**View dropout log** opens the latest 200 event rows in the dashboard, refreshing
once per second while open. The CSV download contains the complete session.

ESP32-S3 internal chip temperature is sampled at 5 Hz (`CHIP_TEMPERATURE_HZ` in
`src/sampling_config.h`). During hardware connections, each received sample is
automatically saved to `dashboard/health-logs/temperature-*.csv` with PC UTC and
device microsecond timestamps, even when full-rate recording is off. The health
panel shows temperature and a CSV download. Full-rate ADC CSV also includes
`chip_temp_c` and `chip_temp_device_us`, repeating the latest temperature until
a new sample arrives. This is chip temperature, not ambient temperature.

Each servo's **−100 µs / +100 µs** buttons change the pulse field by 100 µs and immediately
send it using the selected frequency. They require enabled servos and fresh
telemetry, respects the absolute pulse range, and waits for acknowledgement
before another step. A button is disabled if its next step would exceed the limits.

The orientation indicator displays acceleration-derived roll/pitch and tilt-
compensated magnetic heading in the sensor frame (+X forward, +Y right, +Z up
at rest). It is an estimate without gyro fusion, mounting correction, magnetic
calibration or declination correction. It marks stale sensor data explicitly.
Charts hold their auto-scaled Y range for five seconds before gradually shrinking
it. ADC lines use weighted batch means per screen pixel; translucent min/max bands
preserve excursions. These display changes do not filter the full-rate CSV data.

USB serial and PlatformIO remote are **debug-only** transports. The dashboard
hides them unless **Show debug sources** is checked. Use Wi-Fi TCP for normal
operation; the serial/remote sections below remain for lab debugging.

---

# Nano ESP32 sensor monitor

Firmware acquires ADS7953 channels CH0–CH15 at a requested 10,000 scans/s
(10,000 readings per channel), independently of BMI323/BMM350 I2C polling and
USB telemetry. Timestamped binary ADC batches accompany 20 Hz text status.
The dashboard decodes both. Acceleration is in g, angular velocity in degrees/s,
and magnetic field in microtesla; these are measurements, not fused orientation.

## Wiring

| Signal | ESP32 GPIO | Nano label |
| --- | --- | --- |
| ADS7953 CS | 18 | D9 |
| ADS7953 SDO / MISO | 47 | D12 |
| ADS7953 SCLK | 48 | D13 |
| ADS7953 SDI / MOSI | 38 | D11 |
| ADS7953 GPIO3 / active-low PD | 21 | D10 |
| Fermion SDA | 11 | A4 |
| Fermion SCL | 12 | A5 |

Use common ground and 3.3 V logic. Power the Fermion SEN0695 from 3.3 V;
its default I2C addresses are BMI323 `0x69` and BMM350 `0x15`. Change the
addresses in the code if the address pads have been modified. I2C pull-ups
must go to 3.3 V.

The ADC needs its analog/digital supplies, decoupling, external 2.5 V reference,
and analog input path wired according to the TI datasheet. Use a 3.3 V digital
supply for direct Nano connections. MXO must feed AINP, directly or through the
intended buffer circuit. The firmware configures ADC GPIO3 as the power-down
input and holds GPIO21 high to keep the ADC awake.

`ADC_DOUBLE_RANGE = true` selects 0..2*VREF (0..5 V with a 2.5 V reference). Set it to `false` for 0..VREF,
subject to the ADC analog supply/input limits. For voltage conversion use
`raw * full_scale_voltage / 4096.0`; full scale is VREF or twice VREF.

## Build and run

PlatformIO installs the two DFRobot libraries listed in `platformio.ini`.

```sh
pio run
pio run --target upload
pio device monitor --baud 115200
```

For Arduino IDE, include all files from `src` in the sketch, select Nano ESP32,
and install DFRobot_BMI323 and DFRobot_BMM350. Use the dashboard rather than a
plain terminal for the mixed binary/text stream. The board uses native USB CDC;
115200 is the line-coding setting, not a UART bandwidth limit.

The ADC initializes at 1 MHz, then uses 16 MHz SPI mode 0 with pipelined manual
channel requests (one 16-bit transfer per channel after priming) and 1 µs quiet
time. A high-priority task on core 1 is notified every 100 µs. Invalid channel
IDs, missed timer notifications, and bounded-ring overflow are counted.
I2C polling runs independently on core 0 at 400 kHz. The BMM350 library does not
expose per-sample read status; its rate counter reports read attempts. Hardware
output rates do not imply the same number of distinct measurements over I2C.

## Browser dashboard

From this project directory in PowerShell, run:

```powershell
.\start-dashboard.ps1
```

The launcher uses PlatformIO's Python installation when available and opens
**http://127.0.0.1:8765**. Keep the launcher running while using the dashboard;
Ctrl+C stops it. If PowerShell blocks the script under its execution policy,
run `powershell -ExecutionPolicy Bypass -File .\start-dashboard.ps1`.

The dashboard provides all 16 ADC values, a selectable ADC history plot,
three-axis IMU plots, a raw serial log, stale-data indicators, and CSV export.
It accepts legacy text telemetry and the new mixed binary/text format. Upload
the new firmware and restart the relay to use high-speed acquisition.

ADC cards and history default to scaled values: `y = m * (raw * 5.0 / 4096) + b`.
For use inside the firmware, edit `src/channel_scaling.h`. It defines each
channel's `m` and `b`, the reference voltage, and double-range setting.
Call `adcToScaled(raw, channel)` for a valid channel reading or
`adcToVolts(raw)` for the input voltage. Named current variables update on each
scan; high-speed transport carries raw counts. Rebuild/upload after editing.
Firmware settings and browser scaling settings are independent.
For temporary ADC diagnosis, choose a channel in **Temporary ADC diagnostic
mode** and click **Apply ADC selection**. The board holds the multiplexer on
that input, uses `ADC_DIAGNOSTIC_SPI_HZ` (the same clock as normal scanning by
default), flushes four conversions with 100 us
settling delays at selection changes, and reports only that channel. The UI
shows raw counts and unscaled ADC input volts; other channels display OFF and
are blank in full-rate CSV. Select **Normal · all channels** to restore normal
scanning. This ADC selection does not enable or command servos and is not
persistent across board resets. Serial commands are `ADC CHANNEL 3` (0–15)
and `ADC CHANNEL ALL`. Mode changes are applied by the sole ADC SPI task and
confirmed through firmware telemetry.
Both acquisition clocks and the CS-high recovery delay (`ADC_QUIET_US`) are
configured in `src/sampling_config.h`. For a settling experiment, increase
the delay from 1 to 2–5 microseconds or reduce both clocks. Rebuild/upload
after edits. These changes can reduce the achieved reading rate. The reported
ADC mode includes the actual configured SPI clock and recovery delay.
Edit `src/sampling_config.h` for `ADC_SAMPLE_HZ` (10,000 Hz), `ADC_SPI_HZ`
(16 MHz), and `TELEMETRY_HZ` (20 Hz). ADC timer configuration is applied at
startup; changing `adcSampleHz` afterward does not retime it. The accepted ADC
rate is greater than zero and at most 10,000 Hz. See UI statistics for achieved
rate, maximum scan time, missed ticks, ring drops, sequence gaps and CRC errors.
USB/remote throughput can limit delivery independently of acquisition.
`ADC_CONSECUTIVE_READINGS` in `src/sampling_config.h` sets how many consecutive
conversions to take on each channel before advancing (1–64, default 1).
`ADC_DISCARDED_READINGS` selects how many initial conversions to discard on
each channel (0 through consecutive-count minus one). Its default is 0: every
conversion is kept and sent over USB, including into full-rate CSV recordings.
For example, 10 consecutive and 2 discarded keeps 8 readings per channel per
burst; 10 consecutive and 0 discarded keeps all 10. No readings are averaged.
Retained readings are grouped by their index into the existing 16-channel wire
records, so the decoder and CSV format remain compatible. Each record timestamp
is captured at its CH0 reading; the other channels are acquired later in that
burst, rather than simultaneously. Firmware current/voltage variables use the
last retained reading. The two-frame ADC pipeline is maintained across bursts.
Increasing this count increases SPI work and scan duration; lower `ADC_SAMPLE_HZ`
if missed ticks increase. Rebuild/upload to apply this startup setting.
`ADC_SAMPLE_HZ` is the requested retained reading rate per channel. The timer
interval is `(consecutive - discarded) / ADC_SAMPLE_HZ` seconds: with 10
consecutive, 2 discarded, and 10,000 Hz, each burst emits 8 readings and starts
every 800 microseconds. Increasing the kept count does not multiply the requested
USB record rate. Discarded conversions still add acquisition work, so achieved
rates can be lower than requested. The ADC task periodically yields even when
overloaded, preventing timer backlog from starving the idle watchdog task.
The existing UI ADC rate counter reports retained records per second; MAXSCAN
reports full-burst duration. The fixed ring holds 4096 retained records, so extra
kept readings reduce its backlog time and increase USB/CSV bandwidth requirements.

BMI323 acceleration and gyro run at 6400 Hz high-performance hardware ODR;
BMM350 runs at 400 Hz without averaging. The I2C task polls continuously,
with a brief scheduler yield every 32 cycles. Edit `src/sensor_config.h` for
default acceleration range (±2/4/8/16 g) and gyro range
(±125/250/500/1000/2000 °/s). **Apply ranges** changes these live through the
I2C task and firmware reports the applied settings. Changes last until reset.
BMM350 has a fixed ±2000 µT range. A failed partial change is restored to the
previous range where possible; failed restoration marks BMI323 unavailable.
Include `current_readings.h` to access the latest `totalCurrentAmps` (CH15),
`output5vCurrentAmps` (CH14), `servoCurrentAmps` (CH13),
`output3v3CurrentAmps` (CH12), and `output3v3VoltageVolts` (CH11).
These update every ADC scan using firmware scaling; unavailable readings are
`NAN`. CH8–CH10 are labeled disconnected. Dashboard current defaults match the
firmware's configured slope of 4 A/V; reset browser scaling overrides to load them.

The dashboard also displays digital input levels for GPIO46 (servo power good),
GPIO4 (Hall C), GPIO13 (Hall B), and GPIO14 (Hall A). Firmware uses physical
ESP32 GPIO numbers and configures these as inputs without internal pulls.
Levels are reported in every telemetry frame; missing values display a dash.
Upload the firmware and restart the relay to enable these readings.

### Servo outputs and feedback

CH5 is **S3 FB**, CH6 **PAN FB**, and CH7 **TILT FB**. The dashboard plots all
three together, using the current scaled/raw display selection and plot window.

Edit `src/servo_config.h` for PAN (physical GPIO1), TILT (GPIO2), and S3 (GPIO3).
Each row sets min/center/max **pulse widths in microseconds** and min/center/max
**PWM frequencies in Hz**. Current defaults are 500/1500/2500 µs and fixed 50 Hz.
Pulse width controls servo position; frequency controls pulse repetition.
Each config row ends with separate UI Min/Center/Max pulse presets. TILT's
center preset is 2400 microseconds; absolute pulse limits remain 500–2500.
Expand **Button presets** for each servo to save browser-specific presets or
reset them to firmware defaults. These presets only fill command fields and
do not restrict manual commands within the absolute limits. Saving presets
does not command movement or edit the source configuration file.
The firmware uses independent 14-bit LEDC timers and enforces configured limits.
Outputs start off and remain at their commanded setting until changed, switched
off, or the board resets (disconnecting the UI does not switch them off).

Connect the dashboard and wait for servo telemetry. Click **Enable servos**, then set pulse width/frequency
in **Servo controls**, then click **Command**. Min/Center/Max fill the fields;
**Off** stops that output. Reported values come from the firmware's PWM state,
not a measurement of physical servo position; the feedback graph shows CH5–CH7.
Commands use the active direct USB or PlatformIO remote serial connection.
Command reception runs in a separate task so USB transmit backpressure cannot
hold up PWM updates. The receiver queues acknowledgements for the sole USB
writer, keeping binary ADC packets intact. The UI tracks each axis as queued,
sent, board-confirmed, rejected, or timed out. Commands left unsent for more
than five seconds are cancelled. A successful HTTP request alone does not mean
the servo was commanded. Restart the relay and refresh the page after updating.
GPIO numbers in `servo_config.h` are physical ESP32 numbers: PAN GPIO1=A0/D17,
TILT GPIO2=A1/D18, and S3 GPIO3=A2/D19.
Demo mode simulates PWM state without commanding hardware. Firmware telemetry
supplies the UI's limits; old firmware keeps controls disabled.

Servos boot disabled. **Enable servos** permits commands without resuming previous
PWM output. **Disable servos** stops all three outputs. **E-STOP** stops all three
and latches a command block; **Clear E-stop** leaves them disabled, so enable
them again before commanding movement. Stop requests take priority over queued
commands, and the firmware also enforces the disabled/latched state. The UI
reports board confirmation; an unavailable connection cannot confirm a stop.
This software stop switches PWM off; it does not disconnect servo power.
The latch lasts until cleared or the board resets; reset always boots disabled.

Serial safety commands are `SERVOS ENABLE`, `SERVOS DISABLE`, `SERVOS ESTOP`
(or `ESTOP`), and `SERVOS CLEAR`. To verify these on the remote board, run
`pio remote --agent desktop-o1gdd79 run --force-remote -e arduino_nano_esp32 -t check_safety`.
This briefly commands TILT to 1500 microseconds/50 Hz, checks all outputs off
after E-stop, verifies command blocking, and leaves servos disabled.

Serial commands are `SERVO PAN 1500 50` (pulse µs, frequency Hz) or
`SERVO PAN OFF`, terminated with a newline; substitute TILT or S3 as needed.
Rebuild/upload after editing config, and restart the relay for the new endpoint.
Edit `dashboard/channel-scaling.js` for each channel's default slope `m`, offset
`b`, and output `unit`. Defaults of `m=1`, `b=0`, and `unit='V'` display volts.
For example, `m=2`, `b=-1` maps 1.25 V to 1.5 in the specified unit.
Open **Channel scaling** in the dashboard, edit any channel, and click
**Apply scaling**. Web edits persist in this browser without changing the file.
**Reset to file defaults** removes browser overrides; refresh after editing the
file to load new defaults. Choose **Raw counts** to bypass scaling. CSV exports
and the raw serial monitor continue to contain the original measurements.
Restart the dashboard relay after updating it to serve the new configuration file.

### PlatformIO remote (debug only)

1. In the dashboard, enable **Show debug sources**, then select **PlatformIO remote**.
2. Close your existing `pio remote --agent desktop-o1gdd79 device monitor` session
   so it releases the port. Keep the remote **agent** running.
3. The agent defaults to `desktop-o1gdd79`. Click **Find ports**, select a port, and click **Connect**. The tested device
   was on **COM8**; Windows may assign a different port after reconnecting.
4. Click **Disconnect** before using another monitor or uploading firmware.

Use the same logged-in PlatformIO account as your working remote command.
The relay starts `pio remote --agent NAME device monitor` with explicit serial
settings and PlatformIO's `--sock` bridge, then reads that socket. The bridge
was verified with installed PlatformIO Core **6.2.0**. `--sock` is an internal
PlatformIO interface; a future Core change may require a relay update. The raw
log shows startup/authentication/port errors. `PIO_EXECUTABLE` can override the
path to the `pio` executable if needed.

### Direct connection (debug only)

Connect the Nano by USB to the computer running the relay. Enable **Show debug
sources**, select **Direct USB serial**, click **Find ports**, choose its COM
port (or `/dev/ttyACM0` on Linux), then **Connect**. This mode uses pySerial
directly and does not need a remote agent, PlatformIO login, or browser-specific
USB permissions. Close other serial monitors first. Prefer Wi-Fi TCP in the field.

The Windows launcher reuses pySerial from PlatformIO. For a standalone Python
installation (Python 3.10 or newer), or macOS/Linux:

```sh
python -m pip install -r dashboard/requirements.txt
python dashboard/relay.py
```

Use `python dashboard/relay.py --no-browser --port 8766` to choose another local
port without opening a browser automatically. The PowerShell equivalents are
`-NoBrowser` and `-Port 8766`.

### History and connection behavior

- **Demo** produces clearly labeled simulated data without opening any device.
- The relay and browser retain the latest **1,500 samples** (about five minutes
  at 5 Hz); CSV exports the browser's current buffer, including units in column
  names, source mode, receipt time, device uptime, and missing values as blanks.
- Starting a new connection clears the previous buffer. Disconnecting retains
  it for viewing/export. There is no automatic disk recording.
- Gray readings and a freshness timestamp indicate stale/disconnected data.
  Missing channels and failed IMU reads are never filled from a previous sample.
- The page automatically reconnects to the HTTP relay after an interruption.
  If the PlatformIO serial bridge closes, the relay also retries it after
  1, 2, and 4 seconds. An established connection lasting at least 10 seconds
  resets that retry budget. Captured data and CSV recording remain available,
  while actual acquisition gaps remain counted. Queued controls are cancelled
  on interruption and are never replayed automatically; output state stays
  unconfirmed until fresh board telemetry arrives. Port-busy errors identify
  the need to close another serial monitor. Disconnect cancels retries.
  Reconnect the hardware source using the controls after a source error.
- One relay owns one sensor connection; multiple tabs share that connection.
  Closing a tab does not disconnect it. Use **Disconnect** or stop the launcher.
- The server listens only on this computer's loopback interface. No external
  web hosting, cloud dashboard account, JavaScript CDN, or Node build is needed.
- ADC plot time uses device microseconds and a shared clock anchor; receipt
  timestamps remain available for timing analysis. These plots are measurements,
  not fused orientation or calibrated heading.

### Dashboard verification

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" -m unittest discover -s dashboard -v
```

Tests cover split serial reads, malformed/missing readings, device clock resets,
source lifecycle, a real subprocess/socket bridge with simulated input, direct
serial behavior with a simulated port, and HTTP endpoints. The optional
`python dashboard/browser_check.py` uses Playwright and an already-running relay
to test demo mode, CSV export, mobile layout, and controls; it changes the relay's
source to demo. Install Playwright and its Chromium browser separately to run it.

Live remote reception was verified on `desktop-o1gdd79:COM8`, along with the
browser demo and CSV download. Direct USB was tested with a simulated port;
physical local USB operation still needs testing with the Nano attached.

Implementation references: [PlatformIO remote device commands](https://docs.platformio.org/en/latest/core/userguide/remote/cmd_device.html)
and [pySerial API](https://pyserial.readthedocs.io/en/latest/pyserial_api.html).

## References

- [TI ADS7953 datasheet](https://www.ti.com/lit/ds/symlink/ads7953.pdf)
- [DFRobot SEN0695 Arduino guide](https://wiki.dfrobot.com/sen0695/docs/24067)
- [Nano ESP32 pin numbering](https://support.arduino.cc/hc/en-us/articles/10483225565980-Select-pin-numbering-for-Nano-ESP32-in-Arduino-IDE)

### High-speed stream and exports

The browser fetches summaries every 40 ms. Each ADC batch supplies the latest
value plus per-channel min/max over every valid scan. Plotting reduces these
summaries to screen pixels while retaining the peak envelope. Device timestamps,
rather than remote packet arrival spacing, determine the horizontal axis.
CSV exports the 10,000-summary buffer; it is not a full-rate recording.

**Export buffered raw ADC** downloads the latest 2,048 received binary batches
(about 26 seconds at 10 kHz with 128 scans/batch). The board's 4,096-scan ring
is about 410 ms of backlog. Slow/disconnected transport may overflow that ring;
check firmware drops and receiver sequence gaps. This is a bounded monitor,
not indefinite lossless logging.

Raw `.atb` files concatenate packets: 5-byte magic `00 41 54 42 31`,
little-endian 16-bit payload length, payload, and little-endian CRC32 of payload.
Payload starts with a 16-bit scan count, followed by 46-byte records packed as
Python `struct.Struct('<IQH16H')`: sequence (32-bit), device microseconds (64-bit),
channel validity mask (16-bit), and 16 raw counts (16-bit each). Sequence gaps
include missed scan ticks and transport/ring loss. CRC failures are separately
counted. `dashboard/adc_stream.py` provides incremental decoding and recovery.

Current firmware uses `00 41 54 42 32` (ATB2) with the same length/CRC framing.
The payload starts with scan count (u16), base sequence (u32), and base device
microseconds (u64). Each 30-byte scan contains sequence offset (u16), timestamp
offset in microseconds (u16), validity mask (u16), then 16 losslessly packed
12-bit counts (24 bytes). Two counts a/b occupy bytes `a & 255`,
`(a >> 8) | ((b & 15) << 4)`, `b >> 4`. Batches contain up to 128 scans;
timestamp/sequence offsets never exceed 65535. Both protocol versions decode
to the same sequence, timestamp, validity, and raw counts.

USB transmission runs on core 0 separately from the ADC task on core 1.
`src/usb_cdc_driver.c` vendors the matching MIT-licensed TinyUSB 0.16.0 CDC
driver with an 8 KB transmit FIFO, replacing the SDK's 64-byte FIFO. Its compile
guard requires matching SDK headers. This prevents busy waiting between every
64-byte USB packet. Driver source: https://github.com/hathach/tinyusb/blob/0.16.0/src/class/cdc/cdc_device.c.

**Start stream to CSV** starts full-rate recording to `dashboard/recordings/`
on the computer running the relay. **Stop stream** flushes and closes the CSV,
then enables **Download CSV**; live viewing continues throughout. Each ADC
scan gets one row with device microseconds, sequence, validity, UTC receipt
time, raw counts, volts, scaled values, and latest IMU/GPIO status. The separate
sensor timestamp identifies the age of the repeated 20 Hz status values.
Browser scaling is captured when recording starts. Invalid readings are blank.
Recording uses a separate disk-writer thread and does not depend on browser
polling or the bounded plot buffer. A disk/queue failure is reported rather
than silently dropping CSV rows. Recording remains on until stopped, including
across a browser refresh; restarting the relay closes the file.

Plots render at 30 frames/s with a 200 ms device-time buffer, batch means for
smooth traces, and faint min/max envelopes to retain peaks. CSV/raw exports
preserve the individual unaveraged readings.
The ADC plot supports multiple simultaneous channels: click channel cards or
colored legend entries to add/remove traces. **Show only** returns to one
channel. Selections persist in the browser; colors remain consistent with the
feedback plot. ADC legend entries include channel labels, values, and units.
All plots have clickable legends to hide/show traces; autoscaling uses visible
traces only. ADC traces share one Y axis, including when their units differ.

Run `python dashboard/check_acquisition.py --seconds 15` for a remote-board
measurement with servo outputs untouched. It reports firmware rates, received
scan rate, dropped/invalid scans, and enabled outputs. Hardware wiring and
remote throughput must be verified using these measurements.

To isolate native USB delivery from the remote serial bridge, run
`pio remote --agent desktop-o1gdd79 run --force-remote -e arduino_nano_esp32 -t measure`.
This reads COM8 locally on the agent for 10 seconds without issuing servo commands.
The measurement helper lives in `shared/` so PlatformIO synchronizes it to the agent.

PAN/TILT speed limits are in `src/servo_motion_config.h` (default 30 device
degrees/second). The dashboard's **Apply speed** changes the runtime limit;
0 disables limiting. These settings do not enable outputs. The dashboard's
main Command/±100 buttons apply the entered limit
atomically with each continuous demand; a separate Apply speed click is optional.
Firmware code can
read/write `panMaxSpeedDegPerSec` and `tiltMaxSpeedDegPerSec` using that header.
`latestServoFeedback()` in `src/servo_feedback.h` returns input volts and device
angles: CH7 TILT maps 0.004–3.3 V to 0–360 degrees; CH6 PAN maps five pot turns
through 5:1 gearing to 0–360 device degrees. Feedback is independent of display
scaling. Both PAN and TILT are configured for continuous rotation. Their PWM
frequency stays at 50 Hz; the provisional neutral/stop pulse is 1500 µs.
Calibrate `panNeutralPulseUs`, `tiltNeutralPulseUs`, direction, and each
`ContinuousUsPerDegPerSec` constant in `src/servo_motion_config.h`.

The continuous controller interprets demand relative to neutral as signed
device speed: 500 µs requests -max speed, 1500 µs stops, 2500 µs requests +max
speed. It smoothly accelerates the speed setpoint (60 degrees/s²) and uses
filtered feedback velocity, feedforward, and PI correction to drive the actual
output pulse. Actual speed regulation needs physical tuning; magnitude is not
a universal linear motor-speed calibration. `0` disables feedback regulation
and uses a smoothly changing raw pulse instead; changing to 0 stops the output
first and requires a new command. Stale feedback or excessive speed stops a
regulated output. Losing TCP removes continuous PWM.
PAN and TILT each have an **Enable/Disable overspeed fault** button. It toggles
only overspeed stopping, including during TILT sweeps; speed regulation,
stale-feedback stopping, angle limits and E-stop remain active. The button
shows the board-reported state. Fault stopping defaults ON after every reboot;
firmware code can reference `panOverspeedFaultEnabled` and
`tiltOverspeedFaultEnabled` from `servo_motion_config.h`.
Feedback velocity handles the 360° wrap. The UI reports measured angle/speed,
requested speed, and actual PWM, with a **Neutral / Stop** button. Old position
presets are stored separately. No physical calibration is run automatically.
Restart the dashboard relay after updating its code.
The hotspot uses 20 MHz bandwidth (`WIFI_AP_20MHZ` in `network_config.h`) to
avoid 40 MHz bonding on 2.4 GHz. The PC requests a 1 MiB TCP receive buffer.
Connection health reports the longest socket receive gap and decode time so
network stalls can be distinguished from slow local processing.
The **PID and position** panel selects PAN or TILT and shows aligned speed,
position and PWM-offset plots with clickable colored legends. Speed includes
requested speed, ramped setpoint, measured speed and controller error. Output
includes actual PWM offset, requested offset, P/I/D, feedforward (including
deadband), and startup compensation. These are reported controller terms,
not reconstructed from plot samples. The position trace breaks at the pot wrap;
all three plots use controller timestamps and the selected history window.

TILT voltage mapping and angle limits have source defaults in
`src/tilt_calibration.h`. Include it and call `getTiltCalibration()` to reference
the current settings from firmware code. `latestServoFeedback().tiltDegrees`
uses that mapping. The dashboard's TILT calibration panel lets you edit pot
minimum/maximum volts, zero offset, and minimum/maximum angles. Angle is
`(volts - minVolts) * 360 / (maxVolts - minVolts) - zeroDeg`.
**Set current position as zero** saves the current pot angle as the offset.
Saving settings/zero stops TILT. Settings persist in ESP NVS; source defaults
do not override an already-saved calibration. Min/max limits stop motion toward
an endpoint, including in raw PWM mode; motion back toward the allowed range
remains possible. There is a 0.5-degree stop margin.

**Start slow 360-degree sweep** is explicitly started calibration mode. Choose
1-100 estimated deg/s (default 5), 1-20 rotations, minimum PWM offset (default
42 us), and maximum offset (default 300 us, allowed 1-1000). The cap is a
ceiling, and actual pulses remain within 500-2500 us. The minimum skips the
inactive region at startup; subsequent PWM changes are gradual.

TILT source defaults in `src/servo_motion_config.h` use positive/negative
deadband offsets of 42/60 us (negative provisional), feedforward .03
us/(deg/s), Running Kp .08, Ki .02, and integral bounded to +/-4 us.
Starting and Recovering disable PI windup. PWM rises at 2 us/s and falls at
200 us/s during regulation; explicit stops and faults stop immediately.
A separate startup search adds .5 us/s up to 8 us. Running drive may fall
at most 10 us below the initial confirmed breakaway offset. The sweep cap
bounds all compensation. These values remain under physical tuning.

TILT feedback/control runs at 200 Hz. A three-sample median feeds an 80 ms
regression velocity estimate; a five-sample median feeds angle and sweep
mapping. Raw logging is unchanged. Telemetry reports raw VOLTS and control
FILTERED voltage. Invalid differentiated samples briefly hold PWM rather
than reducing startup drive. Sustained invalid feedback still stops motion.
Pot-voltage direction selects the desired increasing/decreasing voltage trend.
Sweep PWM polarity separately selects whether pulses above neutral increase or
decrease voltage. The sweep learns the actual voltage trend without faulting
for direction and reports which PWM direction increases voltage. This setting applies to
the sweep only; normal TILT polarity is `tiltContinuousDirection` in
`src/servo_motion_config.h`.
It temporarily bypasses angle
limits, so the full turn must be mechanically clear. Completion uses the pot
voltage wrap and return to the starting voltage, rather than an assumed voltage
span. Stop sweep, Off, Disable, E-stop, or connection loss cancels it; stale or
invalid feedback, no initial movement within 60 seconds, a fifteen-second stall
after movement starts, and timeout stop it with a specific reported fault.
Neutral/direction/speed calibration still matter; actual sweep speed requires
physical verification. After completion, **Apply measured voltage range** saves
the extrema; set zero again afterwards. Neither editing nor startup starts a
sweep. Automated checks use simulated servos only.

TILT slow sweep: set whole rotations (1?20), sweep speed, minimum PWM offset/deadband from neutral (0 allowed), and maximum offset in the dashboard before starting. Minimum offset sets both startup drive and feedforward deadband compensation: startup skips the inactive region by immediately applying this offset from neutral, then additional drive ramps gradually. Use 0 for neutral startup. Speed regulation can reduce the output below this offset. Defaults are `tiltSweepRotations`, `tiltSweepMinimumOffsetUs`, and `tiltSweepMaxPulseOffsetUs` in `src/tilt_calibration.h`. Sweeps bypass angle limits and retain stall, timeout, feedback, and enabled overspeed protection.

TILT tuning (2026-10-11): source defaults are in `src/servo_motion_config.h`. The controller reports Starting, Running, and Recovering phases. Starting disables PI windup; Running requires both sustained movement and measurable travel; Recovering begins after a sustained pause. Invalid differentiated speed briefly holds PWM rather than reducing startup drive. Overspeed faults require six fresh readings and 500 ms continuously above the threshold. TILT uses MCPWM at 3.2 MHz (0.3125 us steps at 50 Hz), with feedback/control at 200 Hz and an 80 ms regression velocity estimate. PAN and S3 retain LEDC. The PID OUTPUT trace reports fractional TILT pulse offset. Negative TILT direction remains provisionally calibrated; smooth constant-speed operation is still being tuned.

For shared live tuning, launch `python dashboard/relay.py --host 192.168.20.2 --no-browser` (substitute this PC's actual hotspot IP). Other PCs on the ESP Wi-Fi can open that address on port 8765. The dashboard owns the only ESP TCP connection; `dashboard/tune_servo_shared.py` sends tuning commands through its HTTP API so viewers do not open another ESP socket.

PAN and TILT now offer pot-feedback **position control** as the primary dashboard
command. The servos remain programmed for continuous rotation: enter a target
angle and click **Go to position**. TILT uses its configured voltage mapping,
zero, and angle limits; PAN uses 360 device degrees after its 5:1 gearing.
The positive speed setting slews the angle target in degrees/s; it is not a
guarantee of actual shaft speed. Stop, Disable, E-stop, and connection loss stop
the output. Manual PWM and speed commands remain under an expandable section.

Expand **Position PID gains** on each axis to change P, I, D, integral limit,
PWM offset limit, and position tolerance. Applying gains stops that axis and
does not start movement. Reported values confirm what the ESP applied. These
runtime values reset at ESP restart; source defaults and firmware-accessible
`panPositionPidConfig` / `tiltPositionPidConfig` are in
`src/servo_motion_config.h`. P outputs us/degree, I us/(degree second), and D
us/(degree/second). Derivative acts on measured velocity, with bounded integral,
anti-windup, and neutral output inside the configured position tolerance.
The position plot includes measured angle, commanded target and ramped target.

During TILT calibration sweeps, the calibrated pot seam is detected with endpoint hysteresis, including gradual high-to-low transitions. PI and velocity estimation pause while the last bounded pulse is held; telemetry reports WRAP=1 and unavailable speed. Normal estimation resumes at the opposite endpoint. The seam has an eight-second timeout (`tiltSweepRolloverTimeoutUs`); stale and invalid feedback still stop the sweep.

Position target ramp rate is independently configurable per PAN/TILT in deg/s (default 30), or bypassed with the disable-ramps checkbox. Applying a ramp change stops the axis. TILT runtime values reset on reboot; PAN can be saved as described below. Source defaults are in `src/servo_motion_config.h`. Manual PWM uses a separate SERVO RAW command that writes PWM once and bypasses feedback regulation, ramps, angle checks and overspeed. Off, disable, E-stop and connection loss still stop the output.

PAN calibration and saved settings: dashboard controls expose neutral PWM, PWM polarity (+1/-1), pot voltage endpoints, signed device angle span, zero offset, and position limits. Source calibration defaults are in `src/pan_calibration.h`. Full five-turn pot travel through 5:1 gearing is 360 device degrees. A negative span reverses measured angle direction; PWM polarity specifies which physical pulse direction increases that measured angle. Set current position as zero then adjust relative limits. Position targets follow the numeric angle interval, without shortest-path wrap routing. Manual PWM bypasses position limits. Apply calibration or zero stops PAN; Save PAN settings also stops PAN and stores calibration, position PID, deadbands, ramp enable/rate, speed limit and overspeed enable in ESP NVS. Apply these settings first and wait for reported values before Save. Saving never stores an enabled output or target; boot remains disarmed with PWM off. PAN motion has not yet been physically calibrated or tuned.

Prepared (not yet uploaded): TILT angular/position programming across a provisional 0?110 degrees at 500?2500 us, PAN remains continuous. For angular axes, Go to position maps angle directly to 500?2500 us using `servo_motion_config.h` endpoint angles; TILT zero is added back before pulse mapping. The servo internal controller owns the position loop, so continuous PID/deadband and continuous sweeps are unavailable. Target ramps remain optional and configurable. Manual PWM remains direct. Refine endpoint angles after IMU measurement. Angular ramps start from the last commanded PWM; pot mapping is independent and not yet aligned to mechanical travel.

IMU TILT control (prepared, upload pending): BMI323 Y-axis planar gravity angle plus gyro complementary filtering, unwrapped across 90/180 degrees. X roll is selectable. The moving IMU supplies angle/velocity to the angular position controller; the pot remains diagnostic. Calibrate the two PWM/IMU points using the dashboard mapping controls before Go to position is enabled. Feedforward is the calibrated angular PWM map, PID adds a bounded correction without deadband. Mapping, zero and gains currently reset on reboot; defaults are in `src/servo_motion_config.h`. Manual SERVO RAW bypasses the angle loop. Loss of IMU feedback stops angle control; disconnect/E-stop/Off stop outputs.
