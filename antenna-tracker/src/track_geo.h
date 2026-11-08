#pragma once
#include <math.h>

// Geographic helpers for TRACK HOME / TRACK TARGET (host speaks lat/lon/alt only).

inline float trackWrap360(float deg) {
  deg = fmodf(deg, 360.f);
  if (deg < 0) deg += 360.f;
  return deg;
}

inline float trackHaversineM(float lat1, float lon1, float lat2, float lon2) {
  constexpr float k = 0.01745329252f; // pi/180
  const float p1 = lat1 * k, p2 = lat2 * k;
  const float dp = (lat2 - lat1) * k, dl = (lon2 - lon1) * k;
  const float a = sinf(dp * .5f) * sinf(dp * .5f) +
    cosf(p1) * cosf(p2) * sinf(dl * .5f) * sinf(dl * .5f);
  return 2.f * 6371000.f * asinf(fminf(1.f, sqrtf(a)));
}

inline float trackBearingDeg(float lat1, float lon1, float lat2, float lon2) {
  constexpr float k = 0.01745329252f;
  const float p1 = lat1 * k, p2 = lat2 * k, dl = (lon2 - lon1) * k;
  const float y = sinf(dl) * cosf(p2);
  const float x = cosf(p1) * sinf(p2) - sinf(p1) * cosf(p2) * cosf(dl);
  return trackWrap360(atan2f(y, x) / k);
}

struct TrackHome {
  bool valid = false;
  float lat = NAN;
  float lon = NAN;
  float alt = 0;       // antenna AGL m
  float decl = 0;      // mag declination: true ≈ mag + decl (TRACK pan = azTrue − decl)
  float panAlign = 0;  // pot-era leftover; ignored by Mag TRACK
  bool panInvert = false; // pot-era leftover; ignored by Mag TRACK
};

inline bool validTrackHomeCoords(float lat, float lon, float alt) {
  return isfinite(lat) && isfinite(lon) && isfinite(alt) &&
    fabsf(lat) <= 90.f && fabsf(lon) <= 180.f && alt >= 0.f && alt <= 10000.f;
}

inline bool validTrackDecl(float decl) {
  return isfinite(decl) && fabsf(decl) <= 360.f;
}

inline bool validTrackAlign(float align) {
  return isfinite(align) && fabsf(align) <= 360.f;
}
