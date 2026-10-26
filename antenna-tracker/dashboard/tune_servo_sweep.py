import json,time,math
from pathlib import Path
from relay import Relay
r=Relay(); rows=[]; started=False
try:
 r.connect(dict(mode='tcp',port='192.168.20.1:9000'))
 deadline=time.monotonic()+15
 while time.monotonic()<deadline:
  s=r.snapshot(); latest=s.get('latest') or {}
  if latest.get('tilt_config') and latest.get('servos') and latest.get('sensor_received_at',0)>time.time()-.3:break
  time.sleep(.05)
 else:raise RuntimeError('No fresh servo feedback')
 if not s['servo_safety']['armed']:r.command_safety(dict(action='ENABLE'));time.sleep(.5)
 r.command_servo_overspeed(dict(axis='TILT',enabled=True));time.sleep(.3)
 r.command_tilt(dict(action='sweep_start',speed=5,direction=1,polarity=1,cap=55,minimum=47,rotations=1));started=True
 begin=time.monotonic();laststamp=None;lastv=latest['tilt_config']['volts'];travel=0
 while time.monotonic()-begin<40:
  s=r.snapshot();v=s.get('latest') or {}; t=v.get('tilt_config') or {};m=v.get('servo_motion',{}).get('TILT',{});p=v.get('servos',{}).get('TILT',{})
  if time.time()-v.get('sensor_received_at',0)>.4:raise RuntimeError('Telemetry stale; stopping')
  stamp=v.get('sensor_device_ms')
  if stamp!=laststamp:
   volts=t.get('filtered',t.get('volts',lastv)); delta=(volts-lastv)*360/3.296;delta=(delta+180)%360-180;travel+=abs(delta);lastv=volts;laststamp=stamp
   row=dict(sec=round(time.monotonic()-begin,3),stamp=stamp,volts=volts,speed=m.get('speed'),pulse=p.get('pulse'),sweep=t.get('sweep'),travel=travel,pid=v.get('servo_pid',{}).get('TILT',{}));rows.append(row)
   if len(rows)%20==0:print(json.dumps(row),flush=True)
   if abs(m.get('speed',0))>100 or travel>25:print('Bounded motion limit reached',flush=True);break
   if time.monotonic()-begin>1 and t.get('sweep')!=1:print('Sweep stopped '+str(t),flush=True);break
  time.sleep(.025)
finally:
 if started:
  try:r.command_tilt(dict(action='sweep_stop'));time.sleep(.2);r.command_servo(dict(axis='TILT',pulse=1500,frequency=50,continuous=True,speed_limit=0));time.sleep(.5);r.command_servo(dict(axis='TILT',off=True));time.sleep(.5)
  except Exception as exc:print('Stop error:',exc)
 Path('dashboard/servo-tuning-trial5.json').write_text(json.dumps(rows,indent=2))
 r.disconnect()
