"""Bounded TILT trial through the shared dashboard; never opens a second ESP socket."""
import argparse,json,time,urllib.request
from pathlib import Path
BASE='http://192.168.20.2:8765'
parser=argparse.ArgumentParser()
parser.add_argument('--minimum',type=float,default=48)
parser.add_argument('--speed',type=float,default=36)
parser.add_argument('--cap',type=float,default=55)
parser.add_argument('--seconds',type=float,default=600)
parser.add_argument('--rotations',type=int,default=5)
parser.add_argument('--max-degrees',type=float,default=2000)
parser.add_argument('--no-overspeed',action='store_true',help='Disable speed-based stops for this explicitly requested trial')
args=parser.parse_args()
if not (0 <= args.minimum <= args.cap <= 100 and 1 <= args.speed <= 100 and 0 < args.seconds <= 900 and 1 <= args.rotations <= 5 and 0 < args.max_degrees <= 2000):
 raise ValueError('Invalid bounded trial settings')
def api(path,data=None):
 body=None if data is None else json.dumps(data).encode()
 req=urllib.request.Request(BASE+'/api/'+('state?since=2147483647' if path == 'state' else path),data=body,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=2) as response:return json.load(response)
rows=[]; started=False; original=None
try:
 state=api('state');v=state.get('latest') or {}
 deadline=time.monotonic()+30
 while (state['status']!='connected' or time.time()-(v.get('sensor_received_at') or 0)>4) and time.monotonic()<deadline:
  time.sleep(.5);state=api('state');v=state.get('latest') or {}
 if state['status']!='connected' or time.time()-(v.get('sensor_received_at') or 0)>4:raise RuntimeError('Wait for fresh shared dashboard telemetry')
 original=dict(armed=state['servo_safety']['armed'],speed=v['servo_motion']['TILT']['limit'],overspeed=bool(v['servo_motion']['TILT'].get('osfault',1)))
 if not original['armed']:api('servo-safety',dict(action='ENABLE'));time.sleep(.5)
 api('servo-overspeed',dict(axis='TILT',enabled=not args.no_overspeed));time.sleep(.3)
 api('tilt',dict(action='sweep_start',speed=args.speed,direction=1,polarity=1,cap=args.cap,minimum=args.minimum,rotations=args.rotations));started=True
 begin=time.monotonic(); last_stamp=None; last_v=v['tilt_config']['volts'];travel=0;overspeed_count=0
 start_v=last_v
 while time.monotonic()-begin<args.seconds:
  state=api('state');v=state.get('latest') or {};t=v.get('tilt_config') or {};motion=v.get('servo_motion',{}).get('TILT',{});servo=v.get('servos',{}).get('TILT',{})
  if state['status']!='connected' or time.time()-(v.get('sensor_received_at') or 0)>4:raise RuntimeError('Telemetry stale; stopping trial')
  stamp=v.get('sensor_device_ms')
  if stamp!=last_stamp:
   volts=t.get('filtered',t.get('volts',last_v));delta=(volts-last_v)*360/3.296;delta=(delta+180)%360-180;travel+=abs(delta);last_v=volts;last_stamp=stamp
   row=dict(sec=round(time.monotonic()-begin,3),stamp=stamp,volts=volts,raw_volts=t.get('volts'),speed=motion.get('speed'),pulse=servo.get('pulse'),sweep=t.get('sweep'),reason=t.get('reason'),wrap=t.get('wrap'),progress=t.get('progress'),travel=travel,pid=v.get('servo_pid',{}).get('TILT',{}),adc=v.get('adc_mean',v.get('adc')),gpio=v.get('gpio'));rows.append(row)
   if len(rows)%100==0:print(json.dumps(row),flush=True)
   overspeed_count=overspeed_count+1 if motion.get('speed') is not None and abs(motion['speed'])>500 else 0
   if (not args.no_overspeed and overspeed_count>=6) or t.get('progress',0)>args.max_degrees or travel>args.max_degrees*3:print('Motion bound reached',flush=True);break
   if time.monotonic()-begin>1 and t.get('sweep')!=1:print('Sweep stopped '+str(t),flush=True);break
  time.sleep(.025)
finally:
 if started:
  try:
   api('tilt',dict(action='sweep_stop'));time.sleep(.2)
   api('servo',dict(axis='TILT',pulse=1500,frequency=50,continuous=True,speed_limit=0));time.sleep(.5)
   api('servo',dict(axis='TILT',off=True));time.sleep(.3)
   api('servo-speed',dict(axis='TILT',speed=original['speed']));time.sleep(.3)
   api('servo-overspeed',dict(axis='TILT',enabled=original['overspeed']));time.sleep(.3)
   if not original['armed']:api('servo-safety',dict(action='DISABLE'))
  except Exception as exc:print('Stop confirmation needs checking:',exc,flush=True)
 Path('dashboard/servo-tuning-shared-rollover.json').write_text(json.dumps(rows,indent=2))
 Path('dashboard/servo-tuning-'+time.strftime('%Y%m%d-%H%M%S')+'.json').write_text(json.dumps(dict(settings=vars(args),samples=rows),indent=2))
 print('Saved',len(rows),'samples',flush=True)

