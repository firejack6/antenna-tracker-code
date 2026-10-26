"""Compare telemetry noise in quiet five-frame feedback windows."""
import json
import statistics
import sys
from pathlib import Path

for name in sys.argv[1:]:
    data = json.loads(Path(name).read_text(encoding='utf-8-sig'))
    rows = data.get('samples', []) if isinstance(data, dict) else data
    unique = []
    last_stamp = None
    for row in rows:
        stamp = row.get('sensor_device_ms', row.get('stamp'))
        if stamp is None or stamp != last_stamp:
            unique.append(row)
        last_stamp = stamp
    rows = unique
    for command in sorted({row['command'] for row in rows if 'command' in row}):
        part = [row for row in rows if row.get('command') == command]
        raw = [row['raw_volts'] for row in part if row.get('raw_volts') is not None]
        filtered = [row['volts'] for row in part]
        print('  fixed PWM', command, 'raw span mV:', round((max(raw)-min(raw))*1000, 3),
              'filtered span mV:', round((max(filtered)-min(filtered))*1000, 3))
    residuals, differences = [], []
    for i in range(2, len(rows)-2):
        window = [row.get('tilt_config', row) for row in rows[i-2:i+3]]
        volts = [row.get('volts') for row in window]
        if any(value is None for value in volts) or max(volts)-min(volts) > .003:
            continue
        row = window[2]
        residuals.append(1000*(row.get('raw_volts', row['volts'])-row.get('filtered', row['volts'])))
        differences.append(1000*(volts[3]-2*volts[2]+volts[1]))
    print(Path(name).name, 'quiet frames:', len(residuals))
    if residuals:
        print('  raw/filter residual RMS mV:', round(statistics.mean(x*x for x in residuals)**.5, 4))
        ordered = sorted(abs(x) for x in residuals)
        print('  raw/filter median / 90th percentile mV:', round(statistics.median(ordered), 4), round(ordered[int(.9*(len(ordered)-1))], 4))
        print('  median absolute second difference mV:', round(statistics.median(abs(x) for x in differences), 4))
