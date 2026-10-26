import json,time
from pathlib import Path
from relay import Relay
r=Relay()
try:
 r.connect(dict(mode='tcp',port='192.168.20.1:9000'))
 for _ in range(100):
  s=r.snapshot()
  if (s.get('latest') or {}).get('servos'): break
  time.sleep(.1)
 Path('dashboard/servo-tuning-before.json').write_text(json.dumps(s,indent=2))
 print(json.dumps({k:s.get(k) for k in ('status','message','servo_safety','latest','logs')},indent=2)[-14000:])
finally:r.disconnect()

