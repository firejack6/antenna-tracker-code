"""Read-only TCP link check. Close the dashboard connection before running."""
import argparse
import json
from pathlib import Path
import time
from relay import Relay

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--endpoint', default='192.168.20.1:9000')
parser.add_argument('--seconds', type=int, default=30)
args = parser.parse_args()
relay = Relay()
checks = []
try:
    relay.connect(dict(mode='tcp', port=args.endpoint))
    for _ in range(args.seconds):
        time.sleep(1)
        state = relay.snapshot(10**12)
        checks.append(dict(status=state['status'], acquisition=state['acquisition'],
                           dropouts=state['dropouts'], link=(state['latest'] or {}).get('link_health')))
    print(json.dumps(checks[-1] if checks else {}, indent=2))
finally:
    relay.disconnect()
    Path(__file__).with_name('tcp-dropout-validation.json').write_text(json.dumps(checks, indent=2), encoding='utf-8')
