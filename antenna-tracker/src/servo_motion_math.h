#pragma once
#include <math.h>

inline float sweepMeasuredVelocity(float measured, int potDirection, float demand) {
  // Backward slip is negative progress, never forward overspeed.
  return measured * potDirection * (demand >= 0 ? 1 : -1);
}

inline float pulseToDeviceAngle(float pulse, float minPulse, float maxPulse, float minAngle, float maxAngle) {
  return minAngle + (pulse - minPulse) * (maxAngle - minAngle) / (maxPulse - minPulse);
}
inline float deviceAngleToPulse(float angle, float minPulse, float maxPulse, float minAngle, float maxAngle) {
  return minPulse + (angle - minAngle) * (maxPulse - minPulse) / (maxAngle - minAngle);
}
inline float advanceServoAngle(float current, float target, float feedback, float maxStep, float maxLead) {
  const float delta = fminf(maxStep, fmaxf(-maxStep, target - current));
  const float next = current + delta;
  // Hold rather than jump backwards if feedback cannot follow the trajectory.
  // Permit steps towards feedback even while recovering from a tracking error.
  if (fabsf(next - feedback) > maxLead && fabsf(next - feedback) > fabsf(current - feedback)) return current;
  return next;
}

inline float smoothServoAngle(float current, float target, float &velocity,
                              float maxSpeed, float acceleration, float dt) {
  if (dt <= 0) return current;
  const float distance = target - current;
  // Brake smoothly before the endpoint, and accelerate gradually after a
  // start/reversal. A reversal can continue briefly in the old direction.
  const float brakingSpeed = sqrtf(2 * acceleration * fabsf(distance));
  const float desired = copysignf(fminf(maxSpeed, brakingSpeed), distance);
  const float previous = velocity;
  velocity += fminf(acceleration * dt, fmaxf(-acceleration * dt, desired - velocity));
  velocity = fminf(maxSpeed, fmaxf(-maxSpeed, velocity));
  const float step = (previous + velocity) * .5f * dt;
  if ((distance >= 0 && step >= distance) || (distance <= 0 && step <= distance)) {
    velocity = 0; return target;
  }
  return current + step;
}

// Same profile in pulse-µs space (RAW / unregulated CR PWM slew).
inline float smoothServoPulse(float current, float target, float &velocityUsPerSec,
                              float maxRateUsPerSec, float accelUsPerSec2, float dt) {
  if (maxRateUsPerSec <= 0 || accelUsPerSec2 <= 0) {
    velocityUsPerSec = 0;
    return target;
  }
  return smoothServoAngle(current, target, velocityUsPerSec, maxRateUsPerSec, accelUsPerSec2, dt);
}

inline float wrappedAngleDelta(float current, float previous) {
  float delta = current - previous;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}
inline float accelerateVelocity(float current, float target, float acceleration, float dt) {
  return current + fminf(acceleration * dt, fmaxf(-acceleration * dt, target - current));
}
inline float continuousRequestedSpeed(float pulse, float neutral, float minimum, float maximum,
                                      float speedLimit, float deadband) {
  const float offset = pulse - neutral;
  if (fabsf(offset) <= deadband) return 0;
  const float span = offset > 0 ? maximum - neutral : neutral - minimum;
  return copysignf(fminf(1, (fabsf(offset) - deadband) / (span - deadband)) * speedLimit, offset);
}
