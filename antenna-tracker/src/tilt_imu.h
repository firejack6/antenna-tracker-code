#pragma once
#include <math.h>
#include <stdint.h>

struct TiltImuSample {
  float angle[2] = {NAN, NAN}, speed[2] = {NAN, NAN};
  uint64_t deviceUs = 0;
};
inline float imuWrappedDelta(float value) {
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}
// Planar tilt (X roll / Y tilt), unwrapped across 90 and 180 degrees.
// Complementary gravity/gyro filter. No magnetometer or pot feedback.
struct TiltImuFilter {
  TiltImuSample sample;
  uint64_t gravityUs[2] = {};
  void update(float ax, float ay, float az, float gx, float gy, uint64_t us) {
    if (!isfinite(ax) || !isfinite(ay) || !isfinite(az) || !isfinite(gx) || !isfinite(gy)) return;
    const float norm = sqrtf(ax*ax+ay*ay+az*az);
    if (norm < .1f || norm > 3) return;
    const float dt = sample.deviceUs && us > sample.deviceUs ? (us-sample.deviceUs)*1e-6f : 0;
    const float angle[] = {atan2f(ay,az)*180/3.14159265f, atan2f(-ax,az)*180/3.14159265f};
    const float gyro[] = {gx,gy};
    const float plane[] = {hypotf(ay,az),hypotf(ax,az)};
    for (int i=0; i<2; ++i) {
      const bool gravity = norm >= .8f && norm <= 1.2f && plane[i] >= .2f;
      if (gravity) gravityUs[i] = us;
      if (!gravityUs[i] || us-gravityUs[i] > 250000) { sample.angle[i] = sample.speed[i] = NAN; continue; }
      if (!isfinite(sample.angle[i]) || dt <= 0 || dt > .1f) {
        sample.angle[i] = gravity ? angle[i] : NAN;
        sample.speed[i] = gyro[i];
      } else {
        sample.angle[i] += gyro[i]*dt;
        if (gravity) sample.angle[i] += dt/(.5f+dt)*imuWrappedDelta(angle[i]-sample.angle[i]);
        sample.speed[i] += dt/(.02f+dt)*(gyro[i]-sample.speed[i]);
      }
    }
    sample.deviceUs = us;
  }
};
TiltImuSample latestTiltImu();
