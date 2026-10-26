#pragma once
#include <math.h>

// Output is PWM microseconds from neutral; derivative is on measured angle
// (velocity), avoiding a derivative kick when the position target changes.
struct PositionPidConfig {
  float kp, ki, kd, integralLimit, outputLimit, tolerance;
};
inline bool validPositionPid(const PositionPidConfig &c) {
  return isfinite(c.kp) && c.kp >= 0 && c.kp <= 100 &&
    isfinite(c.ki) && c.ki >= 0 && c.ki <= 100 &&
    isfinite(c.kd) && c.kd >= 0 && c.kd <= 100 &&
    isfinite(c.integralLimit) && c.integralLimit >= 0 && c.integralLimit <= 1000 &&
    isfinite(c.outputLimit) && c.outputLimit >= 1 && c.outputLimit <= 1000 &&
    isfinite(c.tolerance) && c.tolerance >= .1f && c.tolerance <= 30;
}
struct PositionPid {
  float integral = 0, error = 0, p = 0, d = 0, deadband = 0, request = 0;
  void reset() { integral = error = p = d = deadband = request = 0; }
  float update(float target, float angle, float velocity, float dt,
               const PositionPidConfig &c, float positiveDeadband, float negativeDeadband,
               bool retainIntegralAtTarget = false) {
    if (!isfinite(target) || !isfinite(angle) || !isfinite(velocity) || dt <= 0) return NAN;
    error = target-angle;
    if (fabsf(error) <= c.tolerance) {
      if (retainIntegralAtTarget) {
        p = 0; d = -c.kd*velocity; deadband = 0;
        request = fminf(c.outputLimit, fmaxf(-c.outputLimit, integral+d));
        return request;
      }
      integral = p = d = deadband = request = 0; return 0;
    }
    p = c.kp*error; d = -c.kd*velocity;
    const float delta = c.ki*error*dt;
    const float candidate = fminf(c.integralLimit, fmaxf(-c.integralLimit, integral+delta));
    const float effort = p+candidate+d;
    const float compensation = effort > 0 ? positiveDeadband : effort < 0 ? -negativeDeadband : 0;
    // Do not wind up into output saturation; allow integration that unwinds it.
    if (fabsf(effort+compensation) <= c.outputLimit || delta*(effort+compensation) < 0) integral = candidate;
    const float output = p+integral+d;
    deadband = output > 0 ? positiveDeadband : output < 0 ? -negativeDeadband : 0;
    request = fminf(c.outputLimit, fmaxf(-c.outputLimit, output+deadband));
    return request;
  }
};
