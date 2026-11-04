#include "servo_internal.h"
#include <Preferences.h>
#include "servo_motion_config.h"
#include "track_geo.h"

namespace servo_internal {
// v1: calibration + PID + deadband + ramp + speed + overspeed
// v2: adds continuous CR tune (ff, rise, fall, search, search_max)
// v3: adds brake confirm seconds
// v4: adds position breakaway spike (offset_us, duration_ms)
// v5: adds position schedule (kp_near, cap_near, schedule_deg, brk_min_scale, settle_deg)
// v6: adds position feedback source (pot/mag) + optional mag soft-iron
struct SavedPanSettingsV1 {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
};
struct SavedPanSettingsV2 {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
  float ff, rise, fall, search, searchMax;
};
struct SavedPanSettingsV3 {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
  float ff, rise, fall, search, searchMax, brake;
};
struct SavedPanSettingsV4 {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
  float ff, rise, fall, search, searchMax, brake;
  float breakawayOffsetUs, breakawayDurationMs;
};
struct SavedPanSettingsV5 {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
  float ff, rise, fall, search, searchMax, brake;
  float breakawayOffsetUs, breakawayDurationMs;
  float kpNear, capNear, scheduleDeg, brkMinScale, settleDeg;
};
struct SavedPanSettings {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
  float ff, rise, fall, search, searchMax, brake;
  float breakawayOffsetUs, breakawayDurationMs;
  float kpNear, capNear, scheduleDeg, brkMinScale, settleDeg;
  int32_t feedback; // PanPositionFeedback
  int32_t magSoftEnabled;
  float magSoftCx, magSoftCy, magSoftSx, magSoftSy;
};

bool validPanCrTune(float ff, float rise, float fall, float search, float searchMax, float brake) {
  return isfinite(ff) && ff >= 0 && ff <= 50 &&
    isfinite(rise) && rise >= 1 && rise <= 500 &&
    isfinite(fall) && fall >= 1 && fall <= 1000 &&
    isfinite(search) && search >= 0 && search <= 100 &&
    isfinite(searchMax) && searchMax >= 0 && searchMax <= 200 &&
    isfinite(brake) && brake >= 0 && brake <= 2;
}

bool validSavedPan(const SavedPanSettings &s) {
  return s.version == 6 && validPanCalibration(s.calibration) && validPositionPid(s.pid) &&
    isfinite(s.plus) && s.plus >= 0 && s.plus <= 1000 && isfinite(s.minus) && s.minus >= 0 && s.minus <= 1000 &&
    isfinite(s.rampRate) && s.rampRate > 0 && s.rampRate <= 360 && isfinite(s.speed) && s.speed >= 0 && s.speed <= 360 &&
    validPanCrTune(s.ff, s.rise, s.fall, s.search, s.searchMax, s.brake) &&
    validPanBreakaway(s.breakawayOffsetUs, s.breakawayDurationMs) &&
    validPanSchedule(s.kpNear, s.capNear, s.scheduleDeg, s.brkMinScale, s.settleDeg) &&
    validPanPositionFeedback(s.feedback) &&
    (s.magSoftEnabled == 0 || (s.magSoftEnabled == 1 && validPanMagSoftIron(s.magSoftCx, s.magSoftCy, s.magSoftSx, s.magSoftSy)));
}
bool validSavedPanV5(const SavedPanSettingsV5 &s) {
  return s.version == 5 && validPanCalibration(s.calibration) && validPositionPid(s.pid) &&
    isfinite(s.plus) && s.plus >= 0 && s.plus <= 1000 && isfinite(s.minus) && s.minus >= 0 && s.minus <= 1000 &&
    isfinite(s.rampRate) && s.rampRate > 0 && s.rampRate <= 360 && isfinite(s.speed) && s.speed >= 0 && s.speed <= 360 &&
    validPanCrTune(s.ff, s.rise, s.fall, s.search, s.searchMax, s.brake) &&
    validPanBreakaway(s.breakawayOffsetUs, s.breakawayDurationMs) &&
    validPanSchedule(s.kpNear, s.capNear, s.scheduleDeg, s.brkMinScale, s.settleDeg);
}
bool validSavedPanV4(const SavedPanSettingsV4 &s) {
  return s.version == 4 && validPanCalibration(s.calibration) && validPositionPid(s.pid) &&
    isfinite(s.plus) && s.plus >= 0 && s.plus <= 1000 && isfinite(s.minus) && s.minus >= 0 && s.minus <= 1000 &&
    isfinite(s.rampRate) && s.rampRate > 0 && s.rampRate <= 360 && isfinite(s.speed) && s.speed >= 0 && s.speed <= 360 &&
    validPanCrTune(s.ff, s.rise, s.fall, s.search, s.searchMax, s.brake) &&
    validPanBreakaway(s.breakawayOffsetUs, s.breakawayDurationMs);
}
bool validSavedPanV3(const SavedPanSettingsV3 &s) {
  return s.version == 3 && validPanCalibration(s.calibration) && validPositionPid(s.pid) &&
    isfinite(s.plus) && s.plus >= 0 && s.plus <= 1000 && isfinite(s.minus) && s.minus >= 0 && s.minus <= 1000 &&
    isfinite(s.rampRate) && s.rampRate > 0 && s.rampRate <= 360 && isfinite(s.speed) && s.speed >= 0 && s.speed <= 360 &&
    validPanCrTune(s.ff, s.rise, s.fall, s.search, s.searchMax, s.brake);
}
bool validSavedPanV2(const SavedPanSettingsV2 &s) {
  return s.version == 2 && validPanCalibration(s.calibration) && validPositionPid(s.pid) &&
    isfinite(s.plus) && s.plus >= 0 && s.plus <= 1000 && isfinite(s.minus) && s.minus >= 0 && s.minus <= 1000 &&
    isfinite(s.rampRate) && s.rampRate > 0 && s.rampRate <= 360 && isfinite(s.speed) && s.speed >= 0 && s.speed <= 360 &&
    validPanCrTune(s.ff, s.rise, s.fall, s.search, s.searchMax, panBrakingConfirmDefaultSeconds);
}
bool validSavedPanV1(const SavedPanSettingsV1 &s) {
  return s.version == 1 && validPanCalibration(s.calibration) && validPositionPid(s.pid) &&
    isfinite(s.plus) && s.plus >= 0 && s.plus <= 1000 && isfinite(s.minus) && s.minus >= 0 && s.minus <= 1000 &&
    isfinite(s.rampRate) && s.rampRate > 0 && s.rampRate <= 360 && isfinite(s.speed) && s.speed >= 0 && s.speed <= 360;
}

static void applyCore(const PanCalibration &calibration, const PositionPidConfig &pid,
                      float plus, float minus, float rampRate, float speed, bool ramp, bool overspeed) {
  panCalibration = calibration; panPositionPidConfig = pid;
  panPositiveDeadbandUs = plus; panNegativeDeadbandUs = minus;
  panPositionRampDegPerSec = rampRate; panMaxSpeedDegPerSec = speed;
  panPositionRampEnabled = ramp; panOverspeedFaultEnabled = overspeed;
}

static void applySchedule(float kpNear, float capNear, float scheduleDeg, float brkMinScale, float settleDeg) {
  panPositionKpNear = kpNear;
  panPositionCapNearUs = capNear;
  panPositionScheduleDeg = scheduleDeg;
  panPositionBreakawayMinScale = brkMinScale;
  panPositionSettleDeg = settleDeg;
}

bool savePanSettings() {
  SavedPanSettings s{6, panCalibration, panPositionPidConfig, panPositiveDeadbandUs, panNegativeDeadbandUs,
    panPositionRampDegPerSec, panMaxSpeedDegPerSec, panPositionRampEnabled, panOverspeedFaultEnabled,
    panContinuousUsPerDegPerSec, panPwmRiseUsPerSec, panPwmFallUsPerSec, panStartupSearchUsPerSec,
    panStartupSearchMaxUs, panBrakingConfirmSeconds,
    panPositionBreakawayOffsetUs, panPositionBreakawayDurationMs,
    panPositionKpNear, panPositionCapNearUs, panPositionScheduleDeg,
    panPositionBreakawayMinScale, panPositionSettleDeg,
    int32_t(panPositionFeedback),
    panMagSoftIron.enabled ? 1 : 0,
    panMagSoftIron.cx, panMagSoftIron.cy, panMagSoftIron.sx, panMagSoftIron.sy};
  if (!validSavedPan(s)) return false;
  Preferences p;
  if (!p.begin("pan-settings", false)) return false;
  const bool ok = p.putBytes("config", &s, sizeof(s)) == sizeof(s); p.end(); return ok;
}

void loadPanSettings() {
  Preferences p;
  if (!p.begin("pan-settings", true)) return;
  const size_t len = p.getBytesLength("config");
  if (len == sizeof(SavedPanSettings)) {
    SavedPanSettings s;
    const bool found = p.getBytes("config", &s, sizeof(s)) == sizeof(s);
    p.end();
    if (!found || !validSavedPan(s)) return;
    applyCore(s.calibration, s.pid, s.plus, s.minus, s.rampRate, s.speed, s.ramp, s.overspeed);
    panContinuousUsPerDegPerSec = s.ff; panPwmRiseUsPerSec = s.rise; panPwmFallUsPerSec = s.fall;
    panStartupSearchUsPerSec = s.search; panStartupSearchMaxUs = s.searchMax;
    panBrakingConfirmSeconds = s.brake;
    panPositionBreakawayOffsetUs = s.breakawayOffsetUs;
    panPositionBreakawayDurationMs = s.breakawayDurationMs;
    applySchedule(s.kpNear, s.capNear, s.scheduleDeg, s.brkMinScale, s.settleDeg);
    panPositionFeedback = PanPositionFeedback(s.feedback);
    if (s.magSoftEnabled) {
      panMagSoftIron.enabled = true;
      panMagSoftIron.cx = s.magSoftCx; panMagSoftIron.cy = s.magSoftCy;
      panMagSoftIron.sx = s.magSoftSx; panMagSoftIron.sy = s.magSoftSy;
    } else {
      panMagSoftIron.enabled = false;
      panMagSoftIron.cx = panMagSoftIron.cy = 0;
      panMagSoftIron.sx = panMagSoftIron.sy = 1;
    }
    panMagHeadingFilter.reset();
    return;
  }
  if (len == sizeof(SavedPanSettingsV5)) {
    SavedPanSettingsV5 s;
    const bool found = p.getBytes("config", &s, sizeof(s)) == sizeof(s);
    p.end();
    if (!found || !validSavedPanV5(s)) return;
    applyCore(s.calibration, s.pid, s.plus, s.minus, s.rampRate, s.speed, s.ramp, s.overspeed);
    panContinuousUsPerDegPerSec = s.ff; panPwmRiseUsPerSec = s.rise; panPwmFallUsPerSec = s.fall;
    panStartupSearchUsPerSec = s.search; panStartupSearchMaxUs = s.searchMax;
    panBrakingConfirmSeconds = s.brake;
    panPositionBreakawayOffsetUs = s.breakawayOffsetUs;
    panPositionBreakawayDurationMs = s.breakawayDurationMs;
    applySchedule(s.kpNear, s.capNear, s.scheduleDeg, s.brkMinScale, s.settleDeg);
    return;
  }
  if (len == sizeof(SavedPanSettingsV4)) {
    SavedPanSettingsV4 s;
    const bool found = p.getBytes("config", &s, sizeof(s)) == sizeof(s);
    p.end();
    if (!found || !validSavedPanV4(s)) return;
    applyCore(s.calibration, s.pid, s.plus, s.minus, s.rampRate, s.speed, s.ramp, s.overspeed);
    panContinuousUsPerDegPerSec = s.ff; panPwmRiseUsPerSec = s.rise; panPwmFallUsPerSec = s.fall;
    panStartupSearchUsPerSec = s.search; panStartupSearchMaxUs = s.searchMax;
    panBrakingConfirmSeconds = s.brake;
    panPositionBreakawayOffsetUs = s.breakawayOffsetUs;
    panPositionBreakawayDurationMs = s.breakawayDurationMs;
    return;
  }
  if (len == sizeof(SavedPanSettingsV3)) {
    SavedPanSettingsV3 s;
    const bool found = p.getBytes("config", &s, sizeof(s)) == sizeof(s);
    p.end();
    if (!found || !validSavedPanV3(s)) return;
    applyCore(s.calibration, s.pid, s.plus, s.minus, s.rampRate, s.speed, s.ramp, s.overspeed);
    panContinuousUsPerDegPerSec = s.ff; panPwmRiseUsPerSec = s.rise; panPwmFallUsPerSec = s.fall;
    panStartupSearchUsPerSec = s.search; panStartupSearchMaxUs = s.searchMax;
    panBrakingConfirmSeconds = s.brake;
    return;
  }
  if (len == sizeof(SavedPanSettingsV2)) {
    SavedPanSettingsV2 s;
    const bool found = p.getBytes("config", &s, sizeof(s)) == sizeof(s);
    p.end();
    if (!found || !validSavedPanV2(s)) return;
    applyCore(s.calibration, s.pid, s.plus, s.minus, s.rampRate, s.speed, s.ramp, s.overspeed);
    panContinuousUsPerDegPerSec = s.ff; panPwmRiseUsPerSec = s.rise; panPwmFallUsPerSec = s.fall;
    panStartupSearchUsPerSec = s.search; panStartupSearchMaxUs = s.searchMax;
    panBrakingConfirmSeconds = panBrakingConfirmDefaultSeconds;
    return;
  }
  if (len == sizeof(SavedPanSettingsV1)) {
    SavedPanSettingsV1 s;
    const bool found = p.getBytes("config", &s, sizeof(s)) == sizeof(s);
    p.end();
    if (!found || !validSavedPanV1(s)) return;
    applyCore(s.calibration, s.pid, s.plus, s.minus, s.rampRate, s.speed, s.ramp, s.overspeed);
    return;
  }
  p.end();
}

struct SavedTrackHome {
  uint32_t version;
  float lat, lon, alt, decl, panAlign;
  int32_t panInvert;
};

bool saveTrackHome() {
  if (!trackHome.valid || !validTrackHomeCoords(trackHome.lat, trackHome.lon, trackHome.alt) ||
      !validTrackDecl(trackHome.decl) || !validTrackAlign(trackHome.panAlign)) {
    return false;
  }
  SavedTrackHome s{1, trackHome.lat, trackHome.lon, trackHome.alt, trackHome.decl, trackHome.panAlign,
    trackHome.panInvert ? 1 : 0};
  Preferences p;
  if (!p.begin("track-home", false)) return false;
  const bool ok = p.putBytes("home", &s, sizeof(s)) == sizeof(s);
  p.end();
  return ok;
}

void loadTrackHome() {
  Preferences p;
  if (!p.begin("track-home", true)) return;
  SavedTrackHome s;
  const bool found = p.getBytesLength("home") == sizeof(s) && p.getBytes("home", &s, sizeof(s)) == sizeof(s);
  p.end();
  if (!found || s.version != 1 || !validTrackHomeCoords(s.lat, s.lon, s.alt) ||
      !validTrackDecl(s.decl) || !validTrackAlign(s.panAlign)) {
    return;
  }
  trackHome.valid = true;
  trackHome.lat = s.lat;
  trackHome.lon = s.lon;
  trackHome.alt = s.alt;
  trackHome.decl = s.decl;
  trackHome.panAlign = s.panAlign;
  trackHome.panInvert = s.panInvert != 0;
}

}  // namespace servo_internal
