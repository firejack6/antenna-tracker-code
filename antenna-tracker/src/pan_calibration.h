#pragma once
#include <math.h>

// Full five-turn pot / 5:1 gearing = 360 DEVICE degrees. Source defaults;
// dashboard calibration and Save PAN settings can override these in NVS.
struct PanCalibration {
  float neutral = 1500, polarity = 1;
  // vmax inset from ~3.54 V rail seen in PAN sweeps (ADC top is soft).
  float vmin = .004f, vmax = 3.45f, span = 360, zero = 0;
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
  if (!validPanCalibration(c) || !isfinite(volts) || volts < c.vmin-.05f || volts > c.vmax+.05f) return NAN;
  return fminf(1, fmaxf(0,(volts-c.vmin)/(c.vmax-c.vmin)))*c.span-c.zero;
}
