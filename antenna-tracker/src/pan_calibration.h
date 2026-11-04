#pragma once
#include <math.h>

// Full five-turn pot / 5:1 gearing = 360 DEVICE degrees. Source defaults;
// dashboard calibration and Save PAN settings can override these in NVS.
struct PanCalibration {
  float neutral = 1500, polarity = 1;
  // vmax at the allowed ceiling so the 0°/360° pot seam (~3.54 V rail) still
  // maps; panAngleFromVolts clamps in-band rather than returning NAN at the lip.
  float vmin = .004f, vmax = 3.5f, span = 360, zero = 0;
  float amin = 0, amax = 360;
};
inline bool validPanCalibration(const PanCalibration &c) {
  return isfinite(c.neutral) && c.neutral >= 500 && c.neutral <= 2500 &&
    (c.polarity == 1 || c.polarity == -1) &&
    isfinite(c.vmin) && isfinite(c.vmax) && c.vmin >= 0 && c.vmax <= 3.5f && c.vmax-c.vmin >= .1f &&
    isfinite(c.span) && fabsf(c.span) >= 1 && fabsf(c.span) <= 360 &&
    isfinite(c.zero) && fabsf(c.zero) <= 360 &&
    isfinite(c.amin) && isfinite(c.amax) && c.amin >= -360 && c.amax <= 360 && c.amin < c.amax;
}
inline float panAngleFromVolts(float volts, const PanCalibration &c) {
  if (!validPanCalibration(c) || !isfinite(volts)) return NAN;
  // Reject only absurd rail faults. Clamp the soft top/bottom so full-circle
  // crossings do not NAN out and abort position/CR control.
  if (volts < c.vmin - .25f || volts > c.vmax + .25f) return NAN;
  const float clamped = fminf(c.vmax, fmaxf(c.vmin, volts));
  return (clamped - c.vmin) / (c.vmax - c.vmin) * c.span - c.zero;
}
