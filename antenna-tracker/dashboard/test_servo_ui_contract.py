"""Contract checks that the browser does not force SERVO RAW for all moves."""
from pathlib import Path
import re
import unittest

APP_JS = Path(__file__).resolve().parent / 'app.js'


class ServoUiContractTests(unittest.TestCase):
    def test_send_servo_does_not_unconditionally_force_manual(self):
        source = APP_JS.read_text(encoding='utf-8')
        self.assertNotRegex(
            source,
            re.compile(r"async function sendServo\(command\) \{[^}]*command\.manual = true;", re.S),
            'sendServo must not force manual=true for every command',
        )
        self.assertIn('command.manual !== true', source)
        self.assertRegex(
            source,
            r"rawCommand\.addEventListener\('click', \(\) => sendServo\(\{[\s\S]*?manual:\s*true",
            'Manual PWM Command button must still pass manual: true',
        )
        self.assertRegex(
            source,
            r"data-step[\s\S]*?sendServo\(\{[\s\S]*?manual:\s*true",
            '±µs step buttons must send Manual PWM (SERVO RAW)',
        )


if __name__ == '__main__':
    unittest.main()
