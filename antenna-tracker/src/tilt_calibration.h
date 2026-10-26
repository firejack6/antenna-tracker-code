#pragma once
#include <math.h>
#include <stdint.h>

// Source-editable defaults. Dashboard changes persist in ESP NVS, not this file.
struct TiltCalibration {
  float minVolts = .004f, maxVolts = 3.3f;
  float zeroDeg = 0, minAngleDeg = 0, maxAngleDeg = 360;
};
constexpr TiltCalibration tiltCalibrationDefaults = {};
constexpr float tiltSweepDefaultSpeedDegPerSec = 5;
constexpr float tiltSweepMaximumSpeedDegPerSec = 100; // Allows 100-deg/s tuning; slow default remains 5.
constexpr float tiltSweepMaxPulseOffsetUs = 300;
constexpr float tiltSweepMinimumOffsetUs = 42; // Live fixed-PWM breakaway; offset from neutral.
constexpr uint64_t tiltSweepRolloverTimeoutUs = 8000000; // Bound uncertain feedback at the pot seam.
constexpr uint64_t tiltSweepStallTimeoutUs = 15000000; // Allow bounded breakaway recovery under changing load.
constexpr int tiltSweepRotations = 1; // Whole pot rotations, 1..20.
constexpr float tiltAngleLimitMarginDeg = .5f;
// ADC endpoint excursions reached 3.47 V during live wraps. Clamp these to
// the calibrated angle endpoint, while rejecting larger invalid voltages.
constexpr float tiltFeedbackEndpointToleranceVolts = .25f;

// Skip the inactive neutral-to-deadband region; subsequent drive still slews.
inline float tiltSweepStartingPulse(float neutral, float minimumOffset, int direction,
                                    int polarity, float absoluteMin, float absoluteMax) {
  return fminf(absoluteMax, fmaxf(absoluteMin, neutral + minimumOffset * direction * polarity));
}


inline bool validTiltCalibration(const TiltCalibration &c) {
  return isfinite(c.minVolts) && isfinite(c.maxVolts) && isfinite(c.zeroDeg) &&
    isfinite(c.minAngleDeg) && isfinite(c.maxAngleDeg) && c.minVolts >= 0 &&
    c.maxVolts <= 5 && c.maxVolts - c.minVolts >= .1f && c.zeroDeg >= 0 &&
    c.zeroDeg <= 360 && c.minAngleDeg >= -360 && c.maxAngleDeg <= 360 &&
    c.minAngleDeg < c.maxAngleDeg && c.maxAngleDeg - c.minAngleDeg <= 360;
}
inline float tiltAngleFromVolts(float volts, const TiltCalibration &c) {
  if (!isfinite(volts) || volts < c.minVolts - .05f || volts > c.maxVolts + tiltFeedbackEndpointToleranceVolts) return NAN;
  return fminf(360, fmaxf(0, (volts - c.minVolts) * 360 / (c.maxVolts - c.minVolts))) - c.zeroDeg;
}
inline bool tiltMovingOutOfLimits(float angle, float direction, const TiltCalibration &c) {
  // A full pot turn is a coordinate mapping, not a mechanical travel limit.
  // Only a narrower configured range restricts manual/velocity commands.
  if (c.maxAngleDeg - c.minAngleDeg >= 359.999f) return false;
  return (direction > 0 && angle >= c.maxAngleDeg - tiltAngleLimitMarginDeg) ||
         (direction < 0 && angle <= c.minAngleDeg + tiltAngleLimitMarginDeg);
}

enum class TiltSweepStatus { Idle, Running, Complete, Cancelled, Fault };
enum class TiltSweepFault { None, NoMovement, StaleFeedback, InvalidVoltage, Timeout, WrongDirection, Overspeed, PwmUpdate };
struct TiltSweep {
  TiltSweepStatus status = TiltSweepStatus::Idle;
  TiltSweepFault fault = TiltSweepFault::None;
  float pulseOffsetCapUs = tiltSweepMaxPulseOffsetUs;
  float minimumOffsetUs = tiltSweepMinimumOffsetUs;
  int rotations = tiltSweepRotations, completedRotations = 0;
  float startVolts = NAN, previousVolts = NAN, minVolts = NAN, maxVolts = NAN;
  float progressDeg = 0, speedDegPerSec = 5;
  float referenceSpanVolts = 3.296f, referenceMinVolts = .004f;
  bool rolloverActive = false, edgeSeen = false;
  float edgeVolts = NAN;
  uint64_t rolloverStartedUs = 0;
  int direction = 1;
  int pwmPolarity = 1; // +1: longer pulses increase pot voltage; -1: decrease.
  int observedDirection = 0;
  int requestedDirection = 1;
  bool wrapped = false;
  uint64_t startedUs = 0;
  uint64_t lastMovementUs = 0;
  float movementVolts = NAN;
  void start(float volts, float speed, int dir, uint64_t now, float span = 3.296f, int turns = tiltSweepRotations) {
    status = TiltSweepStatus::Running; fault = TiltSweepFault::None; startVolts = previousVolts = minVolts = maxVolts = volts;
    rolloverActive = edgeSeen = false; edgeVolts = NAN; rolloverStartedUs = 0;
    rotations = turns; completedRotations = 0;
    progressDeg = 0; speedDegPerSec = speed; direction = dir; wrapped = false; startedUs = now;
    observedDirection = 0;
    requestedDirection = dir;
    lastMovementUs = now; movementVolts = volts;
    referenceSpanVolts = span;
  }
  TiltSweepStatus observe(float volts, uint64_t now) {
    if (status != TiltSweepStatus::Running) return status;
    if (!isfinite(volts) || volts < 0 || volts > 5) { fault = TiltSweepFault::InvalidVoltage; return status = TiltSweepStatus::Fault; }
    if (now - startedUs > uint64_t(360 * rotations / speedDegPerSec * 3 + 30) * 1000000) { fault = TiltSweepFault::Timeout; return status = TiltSweepStatus::Fault; }
    minVolts = fminf(minVolts, volts); maxVolts = fmaxf(maxVolts, volts);
    // Learn the actual trend before interpreting wraps; never stop for polarity.
    if (!observedDirection && !wrapped && completedRotations == 0 && !edgeSeen && !rolloverActive && fabsf(volts - startVolts) >= .02f && fabsf(volts - previousVolts) < .25f) {
      observedDirection = volts > startVolts ? 1 : -1;
      direction = observedDirection;
      progressDeg = fabsf(volts - startVolts) * 360 / referenceSpanVolts;
    }
    if (fabsf(volts - movementVolts) >= .01f) { movementVolts = volts; lastMovementUs = now; }
    // Allow a bounded startup interval for the velocity controller to overcome
    // static deadband. Once moving, use the configured stall watchdog.
    if (now - lastMovementUs > (lastMovementUs == startedUs ? 60000000 : tiltSweepStallTimeoutUs)) {
      fault = TiltSweepFault::NoMovement; return status = TiltSweepStatus::Fault;
    }
    // A rotary pot can roll over through several samples, not one large jump.
    // Arm only at the expected end of its calibrated range; hold drive while
    // traversing that short seam rather than interpreting it as reverse speed.
    const float endpoint = direction > 0 ? referenceMinVolts + referenceSpanVolts : referenceMinVolts;
    if (!rolloverActive && direction * (volts - endpoint) >= -.05f) {
      if (!edgeSeen || direction * (volts - edgeVolts) > 0) edgeVolts = volts;
      edgeSeen = true;
    }
    if (!rolloverActive && edgeSeen && direction * (volts - edgeVolts) < -.03f) {
      rolloverActive = true; rolloverStartedUs = now;
    }
    if (rolloverActive) {
      if (now - rolloverStartedUs > tiltSweepRolloverTimeoutUs) {
        fault = TiltSweepFault::Timeout; return status = TiltSweepStatus::Fault;
      }
      const float opposite = direction > 0 ? referenceMinVolts : referenceMinVolts + referenceSpanVolts;
      if (direction * (volts - opposite) > .02f) { previousVolts = volts; return status; }
      rolloverActive = edgeSeen = false; wrapped = true;
      progressDeg = fmaxf(progressDeg, 360 * (completedRotations + 1) + direction * (volts - startVolts) * 360 / referenceSpanVolts);
      previousVolts = volts;
    }
    const float delta = direction * (volts - previousVolts);
    // Stop on return to the starting voltage after a wrap. This does not rely
    // on knowing the pot's voltage span before the sweep.
    if (wrapped && now - startedUs > 2000000 &&
        direction * (volts - startVolts) >= -.01f && maxVolts - minVolts > .5f) {
      ++completedRotations; wrapped = false;
      progressDeg = 360 * completedRotations; previousVolts = volts;
      if (completedRotations >= rotations) return status = TiltSweepStatus::Complete;
      return status;
    }
    float step = delta;
    // A large backward jump alone is not a full pot wrap. Only an armed
    // endpoint-to-opposite-endpoint crossing above may mark wrapped=true.
    progressDeg = fminf(360 * completedRotations + 359.9f, fmaxf(360 * completedRotations, progressDeg + step * 360 / referenceSpanVolts));
    previousVolts = volts;
    return status;
  }
};

void initTiltCalibration();
TiltCalibration getTiltCalibration();
bool setTiltCalibration(const TiltCalibration &value);
