#pragma once
#include "position_pid.h"
#include "pan_mag_heading.h"

// Pot-feedback position loop. Gains output PWM us from angle error in degrees.
// TILT UI changes are runtime-only. PAN's Save settings stores its current
// tuning in NVS. PAN neutral/polarity/pot mapping defaults: pan_calibration.h.
// Continuous PAN position (map go-to / track). Output is PWM µs from neutral;
// P must clear the ~60/80 µs breakaway deadband near the target. No D — pot
// velocity is noisy, especially across the 0°/360° seam. Live Oct 25 retune:
// 90° wrap settle ~2 s with ramp off + 120 °/s limit.
// SERVO PID kp/cap are the large-error (≈180°) gains. Near gains + schedule
// are runtime (SERVO SCHEDULE PAN / Save PAN settings).
//
// Programmable position feedback source (SERVO FEEDBACK PAN / Save PAN).
// TRACK / go-to close the PAN PID on mag heading. Pot is Tune/diagnostic only.
// FUSION is reserved — do not implement until pot min/max/flat scale works.
enum class PanPositionFeedback : int32_t { Pot = 0, Mag = 1, Fusion = 2 };
constexpr PanPositionFeedback panPositionFeedbackDefault = PanPositionFeedback::Mag;
inline bool validPanPositionFeedback(int value) {
  return value == int(PanPositionFeedback::Pot) || value == int(PanPositionFeedback::Mag);
}
extern PanPositionFeedback panPositionFeedback;
extern PanMagSoftIron panMagSoftIron;
extern PanMagHeadingFilter panMagHeadingFilter;
constexpr PositionPidConfig panPositionPidDefaults = {3.f, .02f, 0, 40, 200, 1.5f};
constexpr float panPositionKpNearDefault = .9f;
constexpr float panPositionCapNearDefaultUs = 100;
constexpr float panPositionScheduleDefaultDeg = 60; // |error| at which far gains are fully on
constexpr float panPositionBreakawayMinScaleDefault = .45f;
constexpr float panPositionSettleDefaultDeg = 12; // deadband ease-out band
extern float panPositionKpNear, panPositionCapNearUs, panPositionScheduleDeg;
extern float panPositionBreakawayMinScale, panPositionSettleDeg;
// Kick the CR servo past static friction before handing to position PID.
// Offset/duration are runtime (SERVO BREAKAWAY PAN / Save PAN settings).
// Applied spike scales with command |error| (floor at minScale).
constexpr float panPositionBreakawayOffsetDefaultUs = 200;
constexpr float panPositionBreakawayDurationDefaultMs = 40;
extern float panPositionBreakawayOffsetUs, panPositionBreakawayDurationMs;
constexpr float panPositionBreakawayMinErrorDeg = 4;
constexpr float panPositionBreakawayMoveDeg = .75f;
constexpr float panPositionBreakawaySpeedDegPerSec = 6;
inline bool validPanSchedule(float kpNear, float capNear, float scheduleDeg, float brkMinScale, float settleDeg) {
  return isfinite(kpNear) && kpNear >= 0 && kpNear <= 100 &&
    isfinite(capNear) && capNear >= 1 && capNear <= 1000 &&
    isfinite(scheduleDeg) && scheduleDeg >= 1 && scheduleDeg <= 180 &&
    isfinite(brkMinScale) && brkMinScale >= 0 && brkMinScale <= 1 &&
    isfinite(settleDeg) && settleDeg >= 1 && settleDeg <= 90;
}
inline float panPositionErrorBlend(float absErrorDeg) {
  if (!(absErrorDeg > 0) || !(panPositionScheduleDeg > 0)) return 0;
  return fminf(1.f, absErrorDeg / panPositionScheduleDeg);
}
// Angular servo: these are PWM correction gains around the IMU angle mapping.
// Conservative IMU position baseline from live bidirectional trials. A larger
// derivative gain excited the servo's internal position loop; keep I/D off.
constexpr PositionPidConfig tiltPositionPidDefaults = {2, 0, 0, 20, 80, .5f};
constexpr bool tiltImuControlEnabled = true;
constexpr int tiltImuAxisDefault = 1; // 0: X roll, 1: Y planar tilt.
// Calibrate two PWM/IMU points before enabling angle commands after startup.
// PWM window is inset from the servo's programmed stops (deadzone). Absolute
// IMU angles depend on how the tracker is sitting; re-zero / remap after moving
// the mount. Pot voltage is the more repeatable mechanical indicator; IMU is
// still the closed-loop feedback while tiltImuControlEnabled is true.
constexpr bool tiltImuMappingDefaultReady = true; // Slow inset sweep Oct 25, 2026 (980–1920 µs @ 20 µs/s).
constexpr float tiltImuZeroDefaultDeg = 0;
constexpr float tiltImuAngleAtMinPulseDefault = 28.6f, tiltImuAngleAtMaxPulseDefault = -106.2f;
constexpr unsigned tiltImuMappedMinPulseDefault = 980, tiltImuMappedMaxPulseDefault = 1920;
extern PositionPidConfig panPositionPidConfig, tiltPositionPidConfig;
// Map go-to wants the setpoint immediately; TILT can keep a soft ramp if re-enabled.
constexpr bool positionRampDefaultEnabled = false;
extern bool panPositionRampEnabled, tiltPositionRampEnabled;
constexpr float positionRampDefaultDegPerSec = 180;
extern float panPositionRampDegPerSec, tiltPositionRampDegPerSec;

// Device/output degrees per second, after gearing. 0 disables the limiter.
constexpr float panDefaultMaxSpeedDegPerSec = 120.0f;
constexpr float tiltDefaultMaxSpeedDegPerSec = 30.0f;

// ANGULAR MODE ONLY (unused while continuousRotation is true): device angle
// at the absolute PWM min/max (500/2500 us).
// The feedback pot's full 360-degree scale is independent of programmed travel.
// TILT provisionally uses 110-degree travel; PAN is 5 turns / 5:1.
// Refine TILT endpoints after IMU measurement; pot voltage mapping is separate.
// Change offsets/direction here to match measured endpoints. Descending angles
// are supported. No automatic movement/calibration is performed.
constexpr float panAngleAtMinPulseDeg = 0.0f;
constexpr float panAngleAtMaxPulseDeg = 360.0f;
constexpr float tiltAngleAtMinPulseDeg = 0.0f;
constexpr float tiltAngleAtMaxPulseDeg = 110.0f;

constexpr float servoMaxAccelerationDegPerSec2 = 60.0f;
// Open-loop PWM trapezoid for RAW / unregulated CR (speed limit 0).
// Softens pulse steps so the mount does not jerk. 0 rate = instant (legacy).
// Runtime override: SERVO PWM SLEW <axis> <max_us_per_s> <accel_us_per_s2>
constexpr float panPwmSlewRateDefaultUsPerSec = 40.0f;
constexpr float panPwmSlewAccelDefaultUsPerSec2 = 80.0f;
constexpr float tiltPwmSlewRateDefaultUsPerSec = 40.0f;
constexpr float tiltPwmSlewAccelDefaultUsPerSec2 = 80.0f;
constexpr float s3PwmSlewRateDefaultUsPerSec = 0.0f;
constexpr float s3PwmSlewAccelDefaultUsPerSec2 = 0.0f;
extern float pwmSlewMaxRateUsPerSec[3];
extern float pwmSlewAccelUsPerSec2[3];
// Feedback supervises the trajectory, rather than repeatedly stopping/restarting
// it at a noisy two-degree boundary. Sustained tracking faults stop the output.
constexpr float servoFeedbackMaxTrackingErrorDeg = 15.0f;
constexpr unsigned servoFeedbackTrackingFaultUs = 500000;
constexpr unsigned servoMotionIntervalUs = 5000; // 200 Hz feedback/control; PWM remains 50 Hz.
constexpr unsigned servoFeedbackTimeoutUs = 100000;

// Runtime values; editable from the dashboard and accessible in firmware code.
extern float panMaxSpeedDegPerSec;
extern float tiltMaxSpeedDegPerSec;
extern bool panOverspeedFaultEnabled;
extern bool tiltOverspeedFaultEnabled;

// Match each servo's PROGRAMMED mode. Pulse widths are speed/direction commands
// in continuous mode and position commands in angular mode. Firmware cannot
// detect the programmer setting. TILT angular, PAN continuous.
constexpr bool panContinuousRotation = true;
constexpr bool tiltContinuousRotation = false;
constexpr unsigned tiltNeutralPulseUs = 1500; // Provisional: calibrate stop pulse.
constexpr int tiltContinuousDirection = 1; // +1: longer pulses increase FB angle.
// Provisional velocity-to-pulse calibration in DEVICE deg/s (after gearing).
// Tune using measured velocity; continuous speed is not linear or load invariant.
// Trapezoid PAN char 2026-10-25 (+60…+100 µs): ~48→147 °/s ⇒ ~0.5 µs/(°/s)
// after ~55 µs breakaway. Prior 3.0 over-drove once past deadband.
// Runtime: PAN CR CONFIG / Save PAN settings (NVS). Bake defaults here after tune.
// Live NVS: with FF-base floor, ~0.10 ≈ +24/−27 °/s at 20 cmd; 0.45 over-sped.
constexpr float panContinuousUsPerDegPerSecDefault = 0.10f;
extern float panContinuousUsPerDegPerSec;
// Successful sweep: substantial movement at 1567–1586 us, not +360 us.
// Conservative local slope; low-speed behavior still needs physical validation.
constexpr float tiltContinuousUsPerDegPerSec = 0.03f;
constexpr float continuousNeutralDeadbandUs = 8.0f;
// Output deadband compensation, separate from the input-command deadband above.
// PAN char (silicone + host/ESP trapezoid): +side moves by +60 µs, −side by −80 µs.
constexpr float panPositiveDeadbandDefaultUs = 60, panNegativeDeadbandDefaultUs = 80;
extern float panPositiveDeadbandUs, panNegativeDeadbandUs;
constexpr float tiltPositiveDeadbandDefaultUs = 42, tiltNegativeDeadbandDefaultUs = 60;
extern float tiltPositiveDeadbandUs, tiltNegativeDeadbandUs; // Negative provisional.
// PAN deadband is ~55–75 µs; 10 µs/s took >5 s just to break away. Rise fast
// to the feedforward baseline; fall stays assertive for stops/reversals.
// Runtime via PAN CR CONFIG (same NVS save as calibration).
constexpr float panPwmRiseDefaultUsPerSec = 200;
constexpr float panPwmFallDefaultUsPerSec = 300;
constexpr float panStartupSearchDefaultUsPerSec = 10;
// Must clear breakaway deadband (+60/-80); 20–30 left the axis stuck in search.
constexpr float panStartupSearchMaxDefaultUs = 50;
extern float panPwmRiseUsPerSec, panPwmFallUsPerSec, panStartupSearchUsPerSec, panStartupSearchMaxUs;
// Overspeed brake confirm (seconds). Wi‑Fi: PAN CR CONFIG … brake. 0 = immediate.
constexpr float panBrakingConfirmDefaultSeconds = 0.05f;
extern float panBrakingConfirmSeconds;
constexpr float continuousMovingThresholdDegPerSec = .5f;
constexpr float continuousVelocityKp = 0.5f; // us / (deg/s)
constexpr float continuousVelocityKi = 0.5f; // us / degree
constexpr float continuousIntegralLimitUs = 100.0f;
// Oct 10 fixed-output trials: 1540/1541 us stationary for 12 s;
// 1542 us averaged ~6.2 deg/s but produced bursts. Breakaway varies with load.
// Small gains avoid magnifying those bursts into large PWM corrections.
// TILT-only PI retune; PAN retains the existing gains. Derivative is omitted
// because velocity is already differentiated/filtered pot feedback.
constexpr float tiltVelocityKp = 0.08f; // us / (deg/s); lower live gains allowed sustained overspeed.
constexpr float tiltStartupVelocityKp = 0; // Search for breakaway without PI windup.
constexpr float tiltMovingConfirmSeconds = .05f;
constexpr float tiltMovingConfirmDegrees = .5f;
constexpr float tiltRunningDriveDropUs = 10;
constexpr float tiltRecoveryConfirmSeconds = .75f;
constexpr float tiltBrakingConfirmSeconds = .08f;
constexpr float tiltVelocityKi = 0.02f; // us / degree
constexpr float tiltIntegralLimitUs = 4;
constexpr float tiltPwmRiseUsPerSec = 2;
constexpr float tiltPwmRecoveryRiseUsPerSec = 10; // After measured movement; avoid stall during recovery.
constexpr float tiltPwmFallUsPerSec = 200; // Running correction; stop/fault still immediate.
constexpr float tiltStartupSearchUsPerSec = .5f;
constexpr float tiltStartupSearchMaxUs = 8;
constexpr float continuousMaxPulseOffsetUs = 250.0f;
constexpr float tiltContinuousMaxPulseOffsetUs = 500.0f;
inline bool validPanBreakaway(float offsetUs, float durationMs) {
  return isfinite(offsetUs) && offsetUs >= 0 && offsetUs <= continuousMaxPulseOffsetUs &&
    isfinite(durationMs) && durationMs >= 0 && durationMs <= 2000;
}
constexpr unsigned continuousFaultDelayUs = 500000;
constexpr unsigned continuousFaultMinimumReadings = 6; // Consecutive fresh feedback readings, plus delay above.
