#pragma once
#include <math.h>
#include <stdint.h>

// Physical ADC-input volts, independent of dashboard m*x+b display scaling.
constexpr float servoFeedbackMinVolts = 0.004f;
constexpr float servoFeedbackMaxVolts = 3.3f;
constexpr float tiltFeedbackTurns = 1.0f;
constexpr float tiltGearRatio = 1.0f;
constexpr float panFeedbackTurns = 5.0f;
constexpr float panGearRatio = 5.0f; // Five motor turns produce one device turn.

inline float feedbackDeviceDegrees(float volts, float turns, float ratio) {
  if (!isfinite(volts) || volts < servoFeedbackMinVolts - .05f || volts > servoFeedbackMaxVolts + .05f) return NAN;
  const float fraction = fminf(1.0f, fmaxf(0.0f, (volts - servoFeedbackMinVolts) / (servoFeedbackMaxVolts - servoFeedbackMinVolts)));
  return fraction * turns * 360.0f / ratio;
}

struct ServoFeedback {
  float panVolts = NAN, tiltVolts = NAN;
  float panDegrees = NAN, tiltDegrees = NAN;
  uint64_t deviceUs = 0;
};
ServoFeedback latestServoFeedback();
