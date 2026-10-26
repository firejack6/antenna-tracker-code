#include "servo_internal.h"
#include <Preferences.h>
#include "servo_motion_config.h"

namespace servo_internal {
// v1: calibration + PID + deadband + ramp + speed + overspeed
// v2: adds continuous CR tune (ff, rise, fall, search, search_max)
// v3: adds brake confirm seconds
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
struct SavedPanSettings {
  uint32_t version;
  PanCalibration calibration;
  PositionPidConfig pid;
  float plus, minus, rampRate, speed;
  bool ramp, overspeed;
  float ff, rise, fall, search, searchMax, brake;
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

bool savePanSettings() {
  SavedPanSettings s{3, panCalibration, panPositionPidConfig, panPositiveDeadbandUs, panNegativeDeadbandUs,
    panPositionRampDegPerSec, panMaxSpeedDegPerSec, panPositionRampEnabled, panOverspeedFaultEnabled,
    panContinuousUsPerDegPerSec, panPwmRiseUsPerSec, panPwmFallUsPerSec, panStartupSearchUsPerSec,
    panStartupSearchMaxUs, panBrakingConfirmSeconds};
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

}  // namespace servo_internal
