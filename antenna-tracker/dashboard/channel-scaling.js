// Per-channel defaults. x is ADC input voltage (raw * 5 / 4096).
// Displayed value = m * x + b. Use unit for the resulting physical unit.
// Browser overrides are stored locally; Reset to file defaults reloads these values.
const CHANNEL_SCALING_DEFAULTS = [
  {m: 1, b: 0, unit: 'V'}, // CH0
  {m: 1, b: 0, unit: 'V'}, // CH1
  {m: 1, b: 0, unit: 'V'}, // CH2
  {m: 1, b: 0, unit: 'V'}, // CH3
  {m: 1, b: 0, unit: 'V'}, // CH4
  {m: 1, b: 0, unit: 'V'}, // CH5
  {m: 1, b: 0, unit: 'V'}, // CH6
  {m: 1, b: 0, unit: 'V'}, // CH7
  {m: 1, b: 0, unit: 'V'}, // CH8
  {m: 1, b: 0, unit: 'V'}, // CH9
  {m: 1, b: 0, unit: 'V'}, // CH10
  {m: 1, b: 0, unit: 'V'}, // CH11: 3.3 V output voltage
  {m: 4, b: 0, unit: 'A'}, // CH12: 3.3 V output current
  {m: 4, b: 0, unit: 'A'}, // CH13: servo current
  {m: 4, b: 0, unit: 'A'}, // CH14: 5 V output current
  {m: 4, b: 0, unit: 'A'}, // CH15: total current
];

const CHANNEL_LABELS = {
  5: 'S3 FB',
  6: 'PAN FB',
  7: 'TILT FB',
  8: 'Disconnected',
  9: 'Disconnected',
  10: 'Disconnected',
  11: '3.3 V output voltage',
  12: '3.3 V output current',
  13: 'Servo current',
  14: '5 V output current',
  15: 'Total current',
};
