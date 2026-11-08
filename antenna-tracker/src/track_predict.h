#pragma once
#include "track_geo.h"
#include <stdint.h>

// Medium track prediction: ENU velocity from TARGET samples, adaptive lead,
// accel-limited, coast across GPS gaps. Runtime only (not NVS).

struct TrackPredictor {
  bool enabled = true;
  bool active = false;       // received at least one TARGET since OFF
  bool haveVel = false;
  bool coasting = false;
  uint64_t lastMeasUs = 0;
  float lat = 0, lon = 0, alt = 0;   // last measurement
  float ve = 0, vn = 0, vu = 0;      // m/s east / north / up
  float emaDt = 1.f;                 // measured sample interval (s)
  float leadExtraS = 0.35f;          // user / UI lead (s)
  float lastLeadS = 0;               // diagnostics
};

// Expanding spiral in az/el after TARGET data is stale (directional antenna reacquisition).
struct TrackSearch {
  bool enabled = true;
  bool active = false;
  bool announced = false;
  float speedDegS = 30.f;       // spiral phase rate (°/s) — UI "speed"
  float gapS = 3.f;             // no TARGET for this long → start spiral (UI)
  float pitchDegPerRev = 6.f;   // radius growth per turn
  float maxRadiusDeg = 40.f;    // cap spiral radius
  float startAz = 0.f;          // true azimuth at search start
  float startEl = 30.f;         // elevation at search start
  float phiDeg = 0.f;
  uint64_t lastUs = 0;
};

// Defaults tuned for ~1 Hz GPS + dish lag; UI can raise leadExtraS.
constexpr float kTrackLatencyS = 0.15f;       // command / loop lag
constexpr float kTrackLeadSampleGain = 0.5f;  // fraction of emaDt in lead
constexpr float kTrackMaxLeadS = 2.5f;
constexpr float kTrackMinDtS = 0.05f;
constexpr float kTrackMaxDtS = 4.f;
constexpr float kTrackMaxAccel = 60.f;        // m/s^2 per axis
constexpr float kTrackMaxSpeed = 450.f;       // m/s per axis
constexpr float kTrackCoastStartGain = 1.6f;  // start coast after this * emaDt
constexpr float kTrackCoastMaxS = 3.f;        // stop extrapolating after this gap
constexpr float kTrackSearchGapDefaultS = 3.f;
constexpr float kTrackSearchGapMinS = 0.5f;
constexpr float kTrackSearchGapMaxS = 60.f;
constexpr float kTrackSearchSpeedMin = 5.f;
constexpr float kTrackSearchSpeedMax = 120.f;

extern TrackPredictor trackPredict;
extern TrackSearch trackSearch;

void trackPredictReset();
void trackPredictSetEnabled(bool on);
void trackPredictSetLead(float extraS);
void trackSearchSetEnabled(bool on);
void trackSearchSetSpeed(float degS);
void trackSearchSetGap(float seconds);
void trackSearchStop();
void trackSearchNoteAim(float azTrue, float el);
// New GPS / TARGET sample. Updates velocity; returns predicted aim (or raw if disabled).
void trackPredictOnTarget(float lat, float lon, float alt, uint64_t nowUs,
                          const TrackHome &home, float *outLat, float *outLon, float *outAlt);
// Between samples: if coasting, refresh aim. Returns true if caller should retarget axes.
bool trackPredictTick(uint64_t nowUs, const TrackHome &home,
                      float *outLat, float *outLon, float *outAlt);
// After data gap: expanding spiral from last aim. Returns true if outAz/outEl updated.
bool trackSearchTick(uint64_t nowUs, float ageS, float *outAz, float *outEl);
