"""Use the same decoder in the dashboard and the agent-local measurement."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shared'))
from adc_protocol import MAGIC, MAGIC2, SCAN, MAX_PAYLOAD, Stream, decode
