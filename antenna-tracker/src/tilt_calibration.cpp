#include "tilt_calibration.h"
#include <Arduino.h>
#include <Preferences.h>
namespace {
portMUX_TYPE calibrationMux = portMUX_INITIALIZER_UNLOCKED;
TiltCalibration calibration = tiltCalibrationDefaults;
}
TiltCalibration getTiltCalibration() {
  portENTER_CRITICAL(&calibrationMux); auto value = calibration; portEXIT_CRITICAL(&calibrationMux); return value;
}
void initTiltCalibration() {
  Preferences preferences;
  if (!preferences.begin("tilt-cal", true)) return;
  TiltCalibration saved;
  const bool found = preferences.getBytesLength("settings") == sizeof(saved) && preferences.getBytes("settings", &saved, sizeof(saved)) == sizeof(saved);
  preferences.end();
  if (found && validTiltCalibration(saved)) {
    portENTER_CRITICAL(&calibrationMux); calibration = saved; portEXIT_CRITICAL(&calibrationMux);
  }
}
bool setTiltCalibration(const TiltCalibration &value) {
  if (!validTiltCalibration(value)) return false;
  Preferences preferences;
  if (!preferences.begin("tilt-cal", false)) return false;
  const bool saved = preferences.putBytes("settings", &value, sizeof(value)) == sizeof(value);
  preferences.end();
  if (saved) { portENTER_CRITICAL(&calibrationMux); calibration = value; portEXIT_CRITICAL(&calibrationMux); }
  return saved;
}
