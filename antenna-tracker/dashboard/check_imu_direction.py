"""Compare gravity-angle change and gyro integral in a recorded raw PWM sweep."""
import json
import math
import sys

rows = json.load(open(sys.argv[1]))['rows']
visits = [[]]
for row in rows:
    if visits[-1] and visits[-1][-1]['label'] != row['label']:
        visits.append([])
    visits[-1].append(row)
for visit in visits:
    if len(visit) < 3:
        continue
    def angle(r):
        x, _, z = r['accel']
        return math.degrees(math.atan2(-x,z))
    delta = (angle(visit[-1])-angle(visit[0])+180)%360-180
    integral = sum((b['sec']-a['sec'])*(a['gyro'][1]+b['gyro'][1])/2 for a,b in zip(visit,visit[1:]))
    print(visit[0]['label'], 'gravity delta', round(delta,2), 'gyro integral',round(integral,2))
