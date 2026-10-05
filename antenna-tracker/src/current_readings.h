#pragma once

// Latest scaled ADC readings in amps, updated every ADC scan.
// NAN until sampled, and NAN when the corresponding ADC reading is invalid.
extern float totalCurrentAmps;         // CH15
extern float output5vCurrentAmps;      // CH14
extern float servoCurrentAmps;         // CH13
extern float output3v3CurrentAmps;     // CH12

// CH11: latest scaled 3.3 V output voltage; NAN when unavailable.
extern float output3v3VoltageVolts;
