from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class FirmwareTransportTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('g++'), 'Native g++ is needed')
    def test_tilt_mapping_limits_and_full_turn_detection(self):
        root = Path(__file__).parent / 'transport_fakes'
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'check_tilt.exe'
            subprocess.run(['g++', '-std=c++17', str(root / 'check_tilt.cpp'), '-o', str(binary)], check=True, capture_output=True)
            subprocess.run([str(binary)], check=True, capture_output=True)
    @unittest.skipUnless(shutil.which('g++'), 'Native g++ is needed')
    def test_feedback_gearing_and_rate_limited_trajectory(self):
        root = Path(__file__).parent / 'transport_fakes'
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'check_motion.exe'
            subprocess.run(['g++', '-std=c++17', str(root / 'check_motion.cpp'), '-o', str(binary)], check=True, capture_output=True)
            subprocess.run([str(binary)], check=True, capture_output=True)

    @unittest.skipUnless(shutil.which('g++'), 'Native g++ is needed for firmware transport checks')
    def test_partial_sends_backpressure_timeout_and_packet_order(self):
        root = Path(__file__).parent / 'transport_fakes'
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'check_transport.exe'
            subprocess.run(['g++', '-std=c++17', '-I', str(root), str(root / 'check_transport.cpp'), '-o', str(binary)], check=True, capture_output=True)
            subprocess.run([str(binary)], check=True, capture_output=True)
