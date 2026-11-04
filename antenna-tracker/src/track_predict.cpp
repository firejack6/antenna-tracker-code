#include "track_predict.h"
#include <math.h>

TrackPredictor trackPredict;

namespace {

constexpr float kDeg = 0.01745329252f;
constexpr float kMPerDegLat = 110540.f;

float mPerDegLon(float latDeg) {
  return 111320.f * cosf(latDeg * kDeg);
}

void toEnu(const TrackHome &home, float lat, float lon, float alt,
           float *e, float *n, float *u) {
  *e = (lon - home.lon) * mPerDegLon(home.lat);
  *n = (lat - home.lat) * kMPerDegLat;
  *u = alt - home.alt;
}

void fromEnu(const TrackHome &home, float e, float n, float u,
             float *lat, float *lon, float *alt) {
  *lat = home.lat + n / kMPerDegLat;
  *lon = home.lon + e / mPerDegLon(home.lat);
  *alt = home.alt + u;
  if (*alt < 0.f) *alt = 0.f;
}

float clampf(float v, float lo, float hi) {
  return fminf(hi, fmaxf(lo, v));
}

void clampVel(float *ve, float *vn, float *vu) {
  *ve = clampf(*ve, -kTrackMaxSpeed, kTrackMaxSpeed);
  *vn = clampf(*vn, -kTrackMaxSpeed, kTrackMaxSpeed);
  *vu = clampf(*vu, -kTrackMaxSpeed, kTrackMaxSpeed);
}

void accelLimit(float *v, float raw, float dt) {
  const float maxDv = kTrackMaxAccel * dt;
  *v += clampf(raw - *v, -maxDv, maxDv);
}

float computeLeadS() {
  float lead = trackPredict.leadExtraS + kTrackLatencyS;
  if (trackPredict.emaDt > 0.f) lead += kTrackLeadSampleGain * trackPredict.emaDt;
  return clampf(lead, 0.f, kTrackMaxLeadS);
}

void extrapolate(uint64_t nowUs, const TrackHome &home,
                 float *outLat, float *outLon, float *outAlt) {
  float e, n, u;
  toEnu(home, trackPredict.lat, trackPredict.lon, trackPredict.alt, &e, &n, &u);
  const float age = trackPredict.lastMeasUs
    ? (nowUs - trackPredict.lastMeasUs) * 1e-6f : 0.f;
  float lead = trackPredict.enabled && trackPredict.haveVel ? computeLeadS() : 0.f;
  // While coasting, still lead from "now" but don't grow lead with a missing sample forever.
  if (trackPredict.coasting) lead = fminf(lead, kTrackMaxLeadS);
  const float t = (trackPredict.enabled && trackPredict.haveVel) ? (age + lead) : 0.f;
  trackPredict.lastLeadS = lead;
  fromEnu(home, e + trackPredict.ve * t, n + trackPredict.vn * t, u + trackPredict.vu * t,
          outLat, outLon, outAlt);
}

}  // namespace

void trackPredictReset() {
  trackPredict.active = false;
  trackPredict.haveVel = false;
  trackPredict.coasting = false;
  trackPredict.lastMeasUs = 0;
  trackPredict.ve = trackPredict.vn = trackPredict.vu = 0;
  trackPredict.emaDt = 1.f;
  trackPredict.lastLeadS = 0;
}

void trackPredictSetEnabled(bool on) {
  trackPredict.enabled = on;
  if (!on) {
    trackPredict.haveVel = false;
    trackPredict.coasting = false;
    trackPredict.ve = trackPredict.vn = trackPredict.vu = 0;
  }
}

void trackPredictSetLead(float extraS) {
  trackPredict.leadExtraS = clampf(extraS, 0.f, kTrackMaxLeadS);
}

void trackPredictOnTarget(float lat, float lon, float alt, uint64_t nowUs,
                          const TrackHome &home, float *outLat, float *outLon, float *outAlt) {
  if (!home.valid) {
    *outLat = lat; *outLon = lon; *outAlt = alt;
    return;
  }
  if (trackPredict.active && trackPredict.lastMeasUs && nowUs > trackPredict.lastMeasUs) {
    const float dt = (nowUs - trackPredict.lastMeasUs) * 1e-6f;
    if (dt >= kTrackMinDtS && dt <= kTrackMaxDtS) {
      float e0, n0, u0, e1, n1, u1;
      toEnu(home, trackPredict.lat, trackPredict.lon, trackPredict.alt, &e0, &n0, &u0);
      toEnu(home, lat, lon, alt, &e1, &n1, &u1);
      const float rawE = (e1 - e0) / dt;
      const float rawN = (n1 - n0) / dt;
      const float rawU = (u1 - u0) / dt;
      if (!trackPredict.haveVel) {
        trackPredict.ve = rawE; trackPredict.vn = rawN; trackPredict.vu = rawU;
        trackPredict.haveVel = true;
      } else {
        accelLimit(&trackPredict.ve, rawE, dt);
        accelLimit(&trackPredict.vn, rawN, dt);
        accelLimit(&trackPredict.vu, rawU, dt);
      }
      clampVel(&trackPredict.ve, &trackPredict.vn, &trackPredict.vu);
      trackPredict.emaDt = trackPredict.emaDt * 0.7f + dt * 0.3f;
    } else if (dt > kTrackMaxDtS) {
      // Huge gap: drop velocity; restart after this sample.
      trackPredict.haveVel = false;
      trackPredict.ve = trackPredict.vn = trackPredict.vu = 0;
    }
  }
  trackPredict.lat = lat;
  trackPredict.lon = lon;
  trackPredict.alt = alt;
  trackPredict.lastMeasUs = nowUs;
  trackPredict.active = true;
  trackPredict.coasting = false;
  if (!trackPredict.enabled || !trackPredict.haveVel) {
    *outLat = lat; *outLon = lon; *outAlt = alt;
    trackPredict.lastLeadS = 0;
    return;
  }
  extrapolate(nowUs, home, outLat, outLon, outAlt);
}

bool trackPredictTick(uint64_t nowUs, const TrackHome &home,
                      float *outLat, float *outLon, float *outAlt) {
  if (!trackPredict.enabled || !trackPredict.active || !trackPredict.haveVel || !home.valid ||
      !trackPredict.lastMeasUs || nowUs <= trackPredict.lastMeasUs) {
    return false;
  }
  const float age = (nowUs - trackPredict.lastMeasUs) * 1e-6f;
  const float coastStart = fmaxf(0.4f, trackPredict.emaDt * kTrackCoastStartGain);
  if (age < coastStart) return false;
  if (age > kTrackCoastMaxS) {
    if (trackPredict.coasting) {
      trackPredict.coasting = false;
      trackPredict.haveVel = false;
      trackPredict.ve = trackPredict.vn = trackPredict.vu = 0;
    }
    return false;
  }
  trackPredict.coasting = true;
  extrapolate(nowUs, home, outLat, outLon, outAlt);
  return true;
}
