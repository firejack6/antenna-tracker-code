"""Summarize recorded IMU position trials without contacting hardware."""
import json
import statistics
import sys
from pathlib import Path

for name in sys.argv[1:]:
    data = json.loads(Path(name).read_text())
    print(name)
    labels = dict.fromkeys(r['label'] for r in data['rows'] if r['label'].startswith('target-'))
    for label in labels:
        rows = [r for r in data['rows'] if r['label'] == label]
        # Repeated targets are separate visits; report each visit independently.
        visits = [[]]
        for row in rows:
            if visits[-1] and row['sec']-visits[-1][-1]['sec'] > .5:
                visits.append([])
            visits[-1].append(row)
        for visit in visits:
            target = float(label[len('target-'):])
            end = visit[-1]['sec']
            tail = [r for r in visit if r['sec'] >= end-3]
            errors = [target-r['imu']['angle'] for r in tail]
            angles = [r['imu']['angle'] for r in tail]
            pulses = [r['servo']['pulse'] for r in tail]
            print(json.dumps(dict(target=target, duration=round(end-visit[0]['sec'],2),
                final_error=round(statistics.median(errors),3),
                tail_angle_span=round(max(angles)-min(angles),3),
                tail_pwm_span=max(pulses)-min(pulses),
                max_error=round(max(abs(target-r['imu']['angle']) for r in visit),3))))
