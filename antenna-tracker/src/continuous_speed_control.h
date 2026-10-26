#pragma once
#include <math.h>
#include <stdint.h>
#include "servo_motion_config.h"

enum class SpeedControlPhase { Stopped, Starting, Running, Recovering };

struct ConsecutiveFeedbackFault {
  unsigned readings = 0;
  uint64_t firstUs = 0, lastStamp = 0;
  void reset() { readings = 0; firstUs = lastStamp = 0; }
  bool update(bool excessive, uint64_t stamp, uint64_t now, unsigned minimumReadings, uint64_t delayUs) {
    if (!excessive) { reset(); return false; }
    if (stamp != lastStamp) {
      if (!readings) firstUs = now;
      ++readings; lastStamp = stamp;
    }
    return readings >= minimumReadings && now-firstUs >= delayUs;
  }
};

struct ContinuousSpeedControl {
  float integral = 0, startupExtra = 0;
  float brakingAnchor = NAN;
  float errorTerm = 0, pTerm = 0, iTerm = 0, feedforwardTerm = 0, startupTerm = 0, requestedOffset = 0;
  int direction = 0;
  bool hasMoved = false;
  SpeedControlPhase phase = SpeedControlPhase::Stopped;
  float movingSeconds = 0, stalledSeconds = 0, overspeedSeconds = 0;
  float movingDistance = 0, breakawayOffset = 0;
  void reset() { hasMoved = false; brakingAnchor = NAN; integral = startupExtra = 0; direction = 0;
    phase = SpeedControlPhase::Stopped; movingSeconds = stalledSeconds = overspeedSeconds = 0;
    movingDistance = breakawayOffset = 0;
    errorTerm = pTerm = iTerm = feedforwardTerm = startupTerm = requestedOffset = 0; }
  float update(float requested, float measured, float currentOffset, float deadband,
               float feedforward, float kp, float ki, float integralLimit,
               float cap, float dt, float riseRate, float fallRate,
               float searchRate, float searchLimit, float movingThreshold,
               float recoveryRiseRate = 0, bool staged = false, float brakeConfirmSeconds = 0.08f) {
    if (dt <= 0) return currentOffset;
    if (requested == 0) { reset(); return 0; }
    // An invalid differentiated sample is not a request to brake. In
    // particular 0*NAN is NAN even with startup gains disabled; fmax would
    // otherwise silently turn that into a zero PWM offset.
    if (!isfinite(measured)) return currentOffset;
    const int sign = requested > 0 ? 1 : -1;
    if (sign != direction) { reset(); direction = sign; }
    const float speed = measured * sign, target = fabsf(requested);
    const float error = target - speed;
    const bool moving = speed >= movingThreshold;
    if (staged) {
      if (phase == SpeedControlPhase::Stopped) phase = SpeedControlPhase::Starting;
      movingSeconds = speed > fmaxf(movingThreshold, target*.2f) ? movingSeconds+dt : 0;
      movingDistance = movingSeconds > 0 ? movingDistance+speed*dt : 0;
      if (phase != SpeedControlPhase::Running && movingSeconds >= tiltMovingConfirmSeconds && movingDistance >= tiltMovingConfirmDegrees) {
        if (!hasMoved) breakawayOffset = currentOffset*sign;
        phase = SpeedControlPhase::Running; hasMoved = true; stalledSeconds = 0;
      }
      if (phase == SpeedControlPhase::Running) {
        stalledSeconds = moving ? 0 : stalledSeconds+dt;
        if (stalledSeconds >= tiltRecoveryConfirmSeconds) {
          phase = SpeedControlPhase::Recovering; movingSeconds = 0; brakingAnchor = NAN;
        }
      }
      if (phase != SpeedControlPhase::Running) { kp = tiltStartupVelocityKp; ki = 0; }
    } else if (speed > 2 * movingThreshold) hasMoved = true;
    // Confirm overspeed on both axes. PAN used to brake on a single noisy
    // differentiated sample and collapse below deadband (false stall).
    overspeedSeconds = speed > target + movingThreshold ? overspeedSeconds + dt : 0;
    const bool recovering = staged ? phase == SpeedControlPhase::Recovering : hasMoved;
    const float activeRiseRate = recovering ? fmaxf(riseRate, recoveryRiseRate) : riseRate;
    // Static drive is separate from PI: never accumulate an integral at rest.
    if (!moving && integral > 0 && (!staged || phase != SpeedControlPhase::Running)) integral *= expf(-dt / .15f);
    const float base = deadband + feedforward * target;
    if (!moving && (!staged || phase != SpeedControlPhase::Running) && currentOffset * sign >= fminf(cap, base + fminf(0, integral)) - 1)
      startupExtra = fminf(searchLimit, startupExtra + searchRate * dt);
    if (speed > target) startupExtra = fmaxf(0, startupExtra - (staged ? searchRate*.1f : (recoveryRiseRate > 0 ? searchRate : fallRate)) * dt);
    // Integrate only when moving and when neither cap nor slew blocks correction.
    const float delta = ki * error * dt;
    // After breakaway, a pause must unwind negative braking trim even when
    // the rising output is slew-limited. Never build positive static integral.
    // Recovery mode is enabled for TILT; other axes retain their tuning.
    if (!moving && hasMoved && recoveryRiseRate > 0 && integral < 0 && (!staged || phase == SpeedControlPhase::Recovering))
      integral *= expf(-dt / .5f);
    float mag = fmaxf(0, base + startupExtra + kp * error + integral);
    const bool blocked = mag >= cap || mag > currentOffset * sign + activeRiseRate * dt;
    if ((moving || (staged && phase == SpeedControlPhase::Running)) && (delta < 0 || !blocked))
      integral = fminf(integralLimit, fmaxf(-integralLimit, integral + delta));
    mag = fmaxf(0, base + startupExtra + kp * error + integral);
    // Noisy differentiated speed was driving mag under breakaway via P alone,
    // before overspeed confirm. Hold the FF baseline until overspeed is confirmed;
    // brake (Wi‑Fi: pan brake confirm s) may then cut below base.
    const bool brakeArmed = staged ? phase == SpeedControlPhase::Running : true;
    const bool confirmedOver = brakeArmed && overspeedSeconds >= fmaxf(0, brakeConfirmSeconds);
    if (!confirmedOver) mag = fmaxf(base, mag);
    float desired = fminf(cap, mag) * sign;
    if (confirmedOver) {
      // Capture once per event: repeated subtraction reacts to filter lag by
      // driving all the way to neutral and causes long stop/start cycles.
      if (!isfinite(brakingAnchor)) brakingAnchor = fmaxf(base, currentOffset * sign);
      desired = fminf(fabsf(desired), fmaxf(0, brakingAnchor - kp * (speed - target))) * sign;
    } else brakingAnchor = NAN;
    // Once moving, do not let one differentiated burst remove all holding
    // drive. A sustained overspeed still trips the independent fault guard.
    if (staged && hasMoved)
      desired = fmaxf(fabsf(desired), fminf(cap, fmaxf(0, breakawayOffset-tiltRunningDriveDropUs))) * sign;
    errorTerm = error * sign; pTerm = kp * error * sign;
    iTerm = integral * sign; feedforwardTerm = base * sign;
    startupTerm = startupExtra * sign; requestedOffset = desired;
    const bool increasing = desired * currentOffset >= 0 && fabsf(desired) > fabsf(currentOffset);
    const float step = (increasing ? activeRiseRate : fallRate) * dt;
    // On reversal, first approach neutral; no accumulated drive crosses over.
    if (desired * currentOffset < 0) desired = 0;
    return currentOffset + fminf(step, fmaxf(-step, desired - currentOffset));
  }
};
