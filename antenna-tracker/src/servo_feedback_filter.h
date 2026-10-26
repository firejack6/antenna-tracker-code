#pragma once
#include <math.h>
#include <stdint.h>

// Median of five distinct feedback updates: reject up to two isolated spikes,
// with about 10 ms delay at the 5 ms control interval.
// A real step or pot wrap passes after three updates; never clamp its speed.
template<unsigned Size = 5> struct ServoPotFilterBase {
  static_assert(Size >= 3 && Size % 2 == 1, "Odd median window required");
  float window[Size] = {};
  float value = NAN;
  unsigned next = 0;
  uint64_t lastUs = 0;
  float update(float volts, uint64_t deviceUs, uint64_t timeoutUs) {
    if (!isfinite(volts) || volts < 0 || volts > 5 || !deviceUs) return value = NAN;
    if (deviceUs == lastUs) return value;
    if (!lastUs || deviceUs < lastUs || deviceUs - lastUs > timeoutUs) {
      for (float &sample : window) sample = volts;
      next = 0;
    }
    lastUs = deviceUs;
    window[next] = volts; next = (next + 1) % Size;
    float sorted[Size];
    for (unsigned i = 0; i < Size; ++i) sorted[i] = window[i];
    for (unsigned i = 1; i < Size; ++i) {
      float sample = sorted[i]; unsigned j = i;
      while (j && sorted[j - 1] > sample) { sorted[j] = sorted[j - 1]; --j; }
      sorted[j] = sample;
    }
    return value = sorted[Size / 2];
  }
};

using ServoPotFilter = ServoPotFilterBase<5>;
using ServoVelocityPotFilter = ServoPotFilterBase<3>; // One-update delay; rejects isolated spikes.

// Regression over 17 updates (~80 ms at 200 Hz), with angle unwrapping.
// Differencing adjacent noisy samples creates false breakaway/overspeed events.
struct ServoVelocityWindow {
  float angles[17] = {}, previous = NAN, unwrapped = 0;
  uint64_t stamps[17] = {}, lastUs = 0;
  unsigned count = 0, next = 0;
  void reset() { count = next = 0; lastUs = 0; previous = NAN; unwrapped = 0; }
  float update(float angle, uint64_t stamp) {
    if (!isfinite(angle) || !stamp) { reset(); return NAN; }
    if (lastUs && (stamp <= lastUs || stamp - lastUs > 100000)) reset();
    if (isfinite(previous)) {
      float delta = angle - previous;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      unwrapped += delta;
    }
    previous = angle; lastUs = stamp;
    angles[next] = unwrapped; stamps[next] = stamp;
    next = (next + 1) % 17; if (count < 17) ++count;
    if (count < 3) return 0;
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (unsigned i = 0; i < count; ++i) {
      const float x = float(int64_t(stamps[i]) - int64_t(stamp)) * 1e-6f;
      sx += x; sy += angles[i]; sxx += x*x; sxy += x*angles[i];
    }
    const float denominator = count*sxx - sx*sx;
    return denominator > 1e-10f ? (count*sxy - sx*sy) / denominator : 0;
  }
};
