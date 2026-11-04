#pragma once
#include <math.h>
#include <stdint.h>

// Tilt-compensated magnetic heading for PAN position PID (same frame as
// dashboard orientation.js). Soft-iron ellipse normalize is optional.
//
// Pot+mag sensor fusion / complementary filter is intentionally NOT here:
// pot vmin/vmax/flat mapping is still broken, so fused angles would fight.
// Until pot scale is trustworthy, close position PID on pot OR mag (with a
// light EMA on mag only).

struct PanMagSoftIron {
  bool enabled = false;
  float cx = 0, cy = 0, sx = 1, sy = 1;
};

inline bool validPanMagSoftIron(float cx, float cy, float sx, float sy) {
  return isfinite(cx) && isfinite(cy) && isfinite(sx) && isfinite(sy) &&
    sx > 1e-3f && sy > 1e-3f && sx < 1e6f && sy < 1e6f &&
    fabsf(cx) < 1e6f && fabsf(cy) < 1e6f;
}

inline float wrap360Deg(float deg) {
  deg = fmodf(deg, 360.f);
  if (deg < 0) deg += 360.f;
  return deg;
}

inline float wrap180Deg(float deg) {
  while (deg > 180.f) deg -= 360.f;
  while (deg < -180.f) deg += 360.f;
  return deg;
}

// Returns heading in [0, 360), or NAN if inputs are unusable.
inline float panMagHeadingDeg(float ax, float ay, float az,
                              float mx, float my, float mz,
                              const PanMagSoftIron &soft = {}) {
  if (!isfinite(ax) || !isfinite(ay) || !isfinite(az) ||
      !isfinite(mx) || !isfinite(my) || !isfinite(mz)) return NAN;
  const float anorm = sqrtf(ax * ax + ay * ay + az * az);
  if (anorm < .1f) return NAN;
  const float roll = atan2f(ay, az);
  const float pitch = atan2f(-ax, sqrtf(ay * ay + az * az));
  float hx = mx * cosf(pitch) + mz * sinf(pitch);
  float hy = mx * sinf(roll) * sinf(pitch) + my * cosf(roll) - mz * sinf(roll) * cosf(pitch);
  if (soft.enabled && soft.sx > 0 && soft.sy > 0) {
    hx = (hx - soft.cx) / soft.sx;
    hy = (hy - soft.cy) / soft.sy;
  }
  if (hypotf(hx, hy) < 1e-6f) return NAN;
  return wrap360Deg(atan2f(-hy, hx) * 180.f / 3.14159265f);
}

// Light EMA on circular heading + differentiated speed for PID D-term.
struct PanMagHeadingFilter {
  float heading = NAN;
  float speed = NAN;
  uint64_t deviceUs = 0;
  // ~80 ms time-constant: enough to tame visible mag noise, still usable for D.
  static constexpr float tauSec = .08f;

  void reset() { heading = speed = NAN; deviceUs = 0; }

  bool update(float rawDeg, uint64_t us) {
    if (!isfinite(rawDeg) || !us) { reset(); return false; }
    rawDeg = wrap360Deg(rawDeg);
    if (!deviceUs || us <= deviceUs || us - deviceUs > 250000) {
      heading = rawDeg;
      speed = 0;
      deviceUs = us;
      return true;
    }
    const float dt = (us - deviceUs) * 1e-6f;
    deviceUs = us;
    const float alpha = dt / (tauSec + dt);
    const float delta = wrap180Deg(rawDeg - heading);
    heading = wrap360Deg(heading + alpha * delta);
    const float instant = delta / dt;
    if (!isfinite(speed)) speed = instant;
    else speed += alpha * (instant - speed);
    return true;
  }

  bool fresh(uint64_t now, uint64_t timeoutUs) const {
    return deviceUs && now >= deviceUs && now - deviceUs <= timeoutUs && isfinite(heading);
  }
};

struct MagImuSample {
  float accel[3] = {NAN, NAN, NAN};
  float mag[3] = {NAN, NAN, NAN};
  bool accelValid = false;
  bool magValid = false;
  uint64_t deviceUs = 0;
};

MagImuSample latestMagImuSample();
