"""Bounded angular TILT calibration/trials through one dashboard TCP relay."""
import argparse,json,time,urllib.request,statistics,math
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--base',default='http://127.0.0.1:8766')
parser.add_argument('--mode',choices=('probe','calibrate','position'),default='probe')
parser.add_argument('--pulse',type=int,default=2140)
parser.add_argument('--pulses',type=int,nargs='+')
parser.add_argument('--step',type=int,default=40)
parser.add_argument('--hold',type=float,default=5)
parser.add_argument('--max-motion',type=float,default=15)
parser.add_argument('--axis',type=int,choices=(0,1),default=1)
parser.add_argument('--mapping',type=float,nargs=2)
parser.add_argument('--mapped-pulses',type=int,nargs=2,default=[900,2000])
parser.add_argument('--gains',type=float,nargs=6,default=[2,0,0,20,80,.5])
parser.add_argument('--offsets',type=float,nargs='+',default=[0,3,0,-3,0])
parser.add_argument('--position-hold',type=float,default=15)
args=parser.parse_args()
def api(path,data=None):
    req=urllib.request.Request(args.base+'/api/'+('state?since=2147483647' if path=='state' else path),data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=2) as response: return json.load(response)
rows=[]; summary=[]; moved=False; initial=None
stamp=None; baseline=None; start=time.monotonic()
def state():
    s=api('state'); latest=s.get('latest') or {}; imu=latest.get('tilt_imu') or {}
    if s.get('status')!='connected' or time.time()-latest.get('received_at',0)>.5 or not isinstance(imu.get('raw'),(int,float)):
        raise RuntimeError('IMU/TCP telemetry unavailable')
    if latest.get('servos',{}).get('TILT',{}).get('mode')!=0: raise RuntimeError('TILT firmware is not angular mode')
    return s,latest,imu

def capture(label,seconds,limit=15):
    global stamp,baseline
    end=time.monotonic()+seconds; values=[]
    while time.monotonic()<end:
        s,l,imu=state()
        raw=imu['raw']
        if baseline is None: baseline=raw
        if abs(raw-baseline)>limit: raise RuntimeError('Bounded trial angle exceeded')
        if imu.get('us')!=stamp:
            stamp=imu.get('us'); servo=l['servos']['TILT']; pos=l.get('servo_position',{}).get('TILT',{})
            row=dict(sec=round(time.monotonic()-start,3),label=label,imu=imu,servo=servo,position=pos,pid=l.get('servo_pid',{}).get('TILT'),accel=l.get('accel'),gyro=l.get('gyro'))
            rows.append(row);values.append(row)
        time.sleep(.025)
    if not values: raise RuntimeError('No new IMU samples')
    tail=values[-min(25,len(values)):]
    result=dict(label=label,raw=statistics.median(r['imu']['raw'] for r in tail),angle=statistics.median(r['imu']['angle'] for r in tail),pulse=statistics.median(r['servo']['pulse'] for r in tail),speed=statistics.median(r['imu']['speed'] for r in tail),span=max(r['imu']['raw'] for r in tail)-min(r['imu']['raw'] for r in tail))
    summary.append(result);print(json.dumps(result),flush=True)
    return result

def raw(pulse):
    if not 500<=pulse<=2500: raise ValueError('PWM outside absolute bounds')
    api('servo',dict(axis='TILT',pulse=pulse,frequency=50,continuous=False,manual=True))

try:
    s,l,imu=state();initial=dict(armed=s.get('servo_safety',{}).get('armed'),imu=imu,servo=l['servos']['TILT'])
    print(json.dumps(dict(initial=initial)),flush=True)
    if args.mode=='probe': capture('stationary',3)
    else:
        if not initial['armed']: api('servo-safety',dict(action='ENABLE'));time.sleep(.4)
        moved=True
        if args.mode=='calibrate':
            if not (1<=args.step<=200 and 2<=args.hold<=12 and 1<=args.max_motion<=150 and 500<=args.pulse-2*args.step and args.pulse<=2500 and (not args.pulses or (len(args.pulses)<=24 and all(500<=p<=2500 for p in args.pulses)))): raise ValueError('Invalid bounded calibration steps')
            for pulse in (args.pulses or (args.pulse,args.pulse-args.step,args.pulse-2*args.step,args.pulse-args.step,args.pulse)):
                raw(pulse);capture('raw-'+str(pulse),args.hold,args.max_motion)
            points=summary[1:]
            xs=[p['pulse'] for p in points];ys=[p['raw'] for p in points]
            mx=statistics.mean(xs);my=statistics.mean(ys)
            slope=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/sum((x-mx)**2 for x in xs)
            intercept=my-slope*mx
            result=dict(valid=10 <= abs(2000*slope) <= 180,slope_deg_per_us=slope,angle500=intercept+500*slope,angle2500=intercept+2500*slope,span=2000*slope)
            print(json.dumps(dict(mapping=result)),flush=True);summary.append(result)
        else:
            if not args.mapping: raise ValueError('Two measured mapping endpoints required')
            raw(1500);capture('settle-1500',8,args.max_motion)
            api('tilt-imu',dict(action='configure',axis=args.axis,zero=0,amin=args.mapping[0],amax=args.mapping[1],pmin=args.mapped_pulses[0],pmax=args.mapped_pulses[1]));time.sleep(.3)
            keys=('kp','ki','kd','ilimit','cap','tolerance')
            api('servo-pid',dict(axis='TILT',**dict(zip(keys,args.gains))));time.sleep(.3)
            api('servo-ramp',dict(axis='TILT',enabled=False));time.sleep(.3)
            s,l,imu=state();current=imu['angle'];baseline=imu['raw']
            if not 2 <= args.position_hold <= 30 or any(abs(o)>60 for o in args.offsets): raise ValueError('Invalid position trial bounds')
            for offset in args.offsets:
                target=current+offset
                api('servo-position',dict(axis='TILT',angle=target));capture('target-'+str(round(target,3)),args.position_hold,args.max_motion)
finally:
    if moved:
        try:api('servo',dict(axis='TILT',off=True))
        except Exception as e:print('STOP FAILED: '+str(e),flush=True)
        if initial and not initial['armed']:
            try:api('servo-safety',dict(action='DISABLE'))
            except Exception:pass
    stampname=time.strftime('%Y%m%d-%H%M%S')
    path=Path('dashboard')/('tilt-imu-'+args.mode+'-'+stampname+'.json')
    path.write_text(json.dumps(dict(initial=initial,summary=summary,rows=rows),indent=2))
    print('Saved '+str(path),flush=True)
