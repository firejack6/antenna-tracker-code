"""Optional SCons target to measure USB locally on the remote agent."""
Import('env')
import subprocess
import sys
from pathlib import Path


def measure(source, target, env):
    root = Path(env.subst('$PROJECT_DIR'))
    shared = root / 'shared'
    script = shared / 'local_check_acquisition.py'
    subprocess.run([sys.executable, str(script), '--seconds', '10'], check=True)

def check_control(source, target, env):
    script = Path(env.subst('$PROJECT_DIR')) / 'shared' / 'local_check_acquisition.py'
    subprocess.run([sys.executable, str(script), '--seconds', '10', '--probe'], check=True)

def check_pwm(source, target, env):
    script = Path(env.subst('$PROJECT_DIR')) / 'shared' / 'local_check_acquisition.py'
    subprocess.run([sys.executable, str(script), '--seconds', '3', '--pulse-probe'], check=True)

def check_safety(source, target, env):
    script = Path(env.subst('$PROJECT_DIR')) / 'shared' / 'check_servo_safety.py'
    subprocess.run([sys.executable, str(script)], check=True)

def check_adc(source, target, env):
    script = Path(env.subst('$PROJECT_DIR')) / 'shared' / 'local_check_acquisition.py'
    subprocess.run([sys.executable, str(script), '--seconds', '3', '--channel-probe', '3'], check=True)


env.AddCustomTarget('measure', None, measure, title='Measure acquisition on agent',
                    description='Read COM8 locally without issuing servo commands')
env.AddCustomTarget('check_control', None, check_control, title='Check command acknowledgement',
                    description='Send TILT OFF and confirm firmware reception while streaming')
env.AddCustomTarget('check_pwm', None, check_pwm, title='Check TILT PWM command',
                    description='Apply 1500 us/50 Hz briefly, then turn TILT OFF')
env.AddCustomTarget('check_safety', None, check_safety, title='Check servo enable and E-stop',
                    description='Check firmware gating, briefly pulse TILT, and leave all outputs disabled')
env.AddCustomTarget('check_adc', None, check_adc, title='Check single ADC channel',
                    description='Read CH3 alone for three seconds, then restore ALL; no servo commands')
