import json,time
from pathlib import Path
from relay import Relay
r=Relay();rows=[]
try:
 r.connect(dict(mode='tcp',port='192.168.20.1:9000'));time.sleep(2)
 s=r.snapshot()
 if not s['servo_safety']['armed']:r.command_safety(dict(action='ENABLE'));time.sleep(.3)
 for pulse in (1542,1544,1546,1547):
  r.command_servo(dict(axis='TILT',pulse=pulse,frequency=50,continuous=True,speed_limit=0))
  begin=time.monotonic();start=None;laststamp=None
  while time.monotonic()-begin<2:
   s=r.snapshot();v=s.get('latest') or {};t=v.get('tilt_config',{});m=v.get('servo_motion',{}).get('TILT',{})
   if time.time()-v.get('sensor_received_at',0)>.4:raise RuntimeError('Stale telemetry')
   if v.get('sensor_device_ms')!=laststamp:
    laststamp=v.get('sensor_device_ms');volts=t.get('filtered');start=volts if start is None else start
    row=dict(command=pulse,sec=time.monotonic()-begin,volts=volts,speed=m.get('speed'),pulse=v.get('servos',{}).get('TILT',{}).get('pulse'));rows.append(row)
    if abs(volts-start)*360/3.296>12 or abs(m.get('speed',0))>40:print('Stopped motion bound',row,flush=True);break
   time.sleep(.025)
  r.command_servo(dict(axis='TILT',off=True));time.sleep(.7)
  subset=[x for x in rows if x['command']==pulse];print(pulse,'volts',subset[0]['volts'],subset[-1]['volts'],'maxspeed',max(abs(x['speed']) for x in subset),flush=True)
finally:
 try:r.command_servo(dict(axis='TILT',off=True));time.sleep(.5)
 except Exception as exc:print(exc)
 Path('dashboard/servo-tuning-pulses.json').write_text(json.dumps(rows,indent=2));r.disconnect()
