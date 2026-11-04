#include "servo_internal.h"
#include "network_transport.h"
#include "acquisition.h"
#include "servo_feedback.h"
#include "tilt_imu.h"
#include "tilt_calibration.h"
#include "pan_mag_heading.h"
#include "track_geo.h"
#include "track_predict.h"
#include <esp_timer.h>
#include <driver/ledc.h>
#include <driver/mcpwm.h>
#include <string.h>
#include <math.h>

namespace servo_internal {

bool applyPositionTarget(int i, float target, const char **error) {
  static const char *errArmed = "position requires enabled output, fresh feedback, valid limits";
  static const char *errPwm = "angle outside programmed PWM mapping";
  static const char *errApply = "position PWM unavailable";
  if (error) *error = nullptr;
  const auto fb = latestServoFeedback();
  const auto calibration = getTiltCalibration();
  const float lower = positionLowerAngle(i);
  const float upper = positionUpperAngle(i);
  const uint64_t nowUs = esp_timer_get_time();
  const bool panMagMode = i == 0 && panPositionFeedback == PanPositionFeedback::Mag;
  bool feedbackOk = false;
  if (usesImu(i)) feedbackOk = tiltImuMappingReady && imuFresh(latestTiltImu(), nowUs);
  else if (panMagMode) {
    const MagImuSample sample = latestMagImuSample();
    const float raw = (sample.magValid && sample.accelValid)
      ? panMagHeadingDeg(sample.accel[0], sample.accel[1], sample.accel[2],
                         sample.mag[0], sample.mag[1], sample.mag[2], panMagSoftIron)
      : NAN;
    if (isfinite(raw) && sample.deviceUs) panMagHeadingFilter.update(raw, sample.deviceUs);
    feedbackOk = panMagHeadingFilter.fresh(nowUs, servoFeedbackTimeoutUs);
  } else feedbackOk = feedbackFresh(fb, i, nowUs);
  if (!armed || estopLatched || !ready[i] || !feedbackOk ||
      !isfinite(target) || target < lower || target > upper ||
      (i == 1 && tiltSweep.status == TiltSweepStatus::Running)) {
    if (error) *error = errArmed;
    return false;
  }
  const float targetPulse = continuous(i) ? float(neutralPulse(i)) : angularPositionPulse(i, target);
  const auto &c = SERVO_CONFIG[i];
  if (!isfinite(targetPulse) || targetPulse < c.minPulseUs || targetPulse > c.maxPulseUs) {
    if (error) *error = errPwm;
    return false;
  }
  // Already in position mode: retarget in place (no PWM stop / PID reset) so TRACK
  // samples slew via the existing ramp instead of stair-stepping.
  if (i < 2 && positionActive[i] && enabled[i]) {
    positionTarget[i] = target;
    targetPulseUs[i] = uint32_t(lroundf(targetPulse));
    return true;
  }
  const bool ramp = i == 0 ? panPositionRampEnabled : tiltPositionRampEnabled;
  const auto &servo = SERVO_CONFIG[i];
  const float startAngle = continuous(i)
    ? (panMagMode ? panMagHeadingFilter.heading : feedbackAngle(fb, i))
    : pulseToDeviceAngle(pulseUs[i], servo.minPulseUs, servo.maxPulseUs, minAngle(i), maxAngle(i)) - (i == 1 ? calibration.zeroDeg : 0);
  const float measured = usesImu(i) ? latestTiltImu().angle[tiltImuAxis]-tiltImuZero : startAngle;
  const float initialAngle = ramp ? measured : target;
  const float initialPulse = continuous(i) ? float(neutralPulse(i)) : angularPositionPulse(i, initialAngle);
  if (!isfinite(initialPulse) || initialPulse < c.minPulseUs || initialPulse > c.maxPulseUs) {
    if (error) *error = errPwm;
    return false;
  }
  stopOutput(i);
  if (!applyPulse(i, initialPulse)) {
    stopOutput(i);
    if (error) *error = errApply;
    return false;
  }
  rampPulseUs[i] = initialPulse; targetPulseUs[i] = uint32_t(lroundf(targetPulse));
  positionSetpoint[i] = initialAngle; positionTarget[i] = target; positionActive[i] = true;
  positionBreakaway[i] = {};
  if (continuous(i) && i == 0 && isfinite(measured)) {
    float err = target - measured;
    if (err > 180) err -= 360;
    else if (err < -180) err += 360;
    if (panPositionBreakawayOffsetUs > 0 && panPositionBreakawayDurationMs > 0 &&
        fabsf(err) > panPositionBreakawayMinErrorDeg) {
      const float blend = fmaxf(panPositionBreakawayMinScale, panPositionErrorBlend(fabsf(err)));
      positionBreakaway[i].active = true;
      positionBreakaway[i].sign = err > 0 ? 1 : -1;
      positionBreakaway[i].startedUs = esp_timer_get_time();
      positionBreakaway[i].startAngle = measured;
      positionBreakaway[i].offsetUs = panPositionBreakawayOffsetUs * blend;
      positionBreakaway[i].maxUs = uint64_t(panPositionBreakawayDurationMs * 1000.f * blend + .5f);
    }
  }
  return true;
}

bool applyTrackLatLonAlt(float lat, float lon, float alt, const char **error) {
  if (error) *error = nullptr;
  if (!trackHome.valid) {
    if (error) *error = "Track error: set TRACK HOME first";
    return false;
  }
  const float range = fmaxf(1.f, trackHaversineM(trackHome.lat, trackHome.lon, lat, lon));
  const float azTrue = trackBearingDeg(trackHome.lat, trackHome.lon, lat, lon);
  const float relAlt = alt - trackHome.alt;
  float el = atanf(relAlt / range) * 57.2957795f;
  if (el < -5.f) el = -5.f;
  if (el > 85.f) el = 85.f;
  float pan;
  if (panPositionFeedback == PanPositionFeedback::Mag) {
    pan = trackWrap360(azTrue - trackHome.decl);
  } else if (trackHome.panInvert) {
    pan = trackWrap360(trackHome.panAlign - azTrue);
  } else {
    pan = trackWrap360(azTrue - trackHome.panAlign);
  }
  const float tilt = -el;
  tiltPositionRampEnabled = true;
  const char *err = nullptr;
  if (!applyPositionTarget(0, pan, &err)) {
    if (error) *error = err ? err : "Track error: PAN position failed";
    return false;
  }
  if (!applyPositionTarget(1, tilt, &err)) {
    if (error) *error = err ? err : "Track error: TILT position failed";
    return false;
  }
  return true;
}

void updateTrackPredictMotion(uint64_t nowUs) {
  if (!trackHome.valid || !trackPredict.enabled || !trackPredict.active) return;
  float lat, lon, alt;
  if (!trackPredictTick(nowUs, trackHome, &lat, &lon, &alt)) return;
  applyTrackLatLonAlt(lat, lon, alt, nullptr);
}

void command(const char *line) {
  if (safetyCommand(line)) return;
  if (!strncmp(line, "TRACK ", 6)) {
    if (!strcmp(line, "TRACK OFF")) {
      trackPredictReset();
      stopOutput(0); stopOutput(1);
      queueControlMessage("Track off"); return;
    }
    float lat = NAN, lon = NAN, alt = NAN, decl = NAN, align = NAN, lead = NAN; int end = 0, invert = -1, pred = -1;
    if (sscanf(line, "TRACK HOME %f %f %f %n", &lat, &lon, &alt, &end) == 3 && end && !line[end]) {
      if (!validTrackHomeCoords(lat, lon, alt)) {
        queueControlMessage("Track error: invalid HOME lat lon alt"); return;
      }
      trackHome.lat = lat; trackHome.lon = lon; trackHome.alt = alt; trackHome.valid = true;
      trackPredictReset();
      queueControlMessage(saveTrackHome() ? "Track HOME saved" : "Track HOME set (NVS save failed)"); return;
    }
    if (sscanf(line, "TRACK DECL %f %n", &decl, &end) == 1 && end && !line[end]) {
      if (!validTrackDecl(decl)) { queueControlMessage("Track error: invalid DECL"); return; }
      trackHome.decl = decl;
      queueControlMessage(trackHome.valid && saveTrackHome() ? "Track DECL saved" : "Track DECL set"); return;
    }
    if (sscanf(line, "TRACK ALIGN %f %n", &align, &end) == 1 && end && !line[end]) {
      if (!validTrackAlign(align)) { queueControlMessage("Track error: invalid ALIGN"); return; }
      trackHome.panAlign = align;
      queueControlMessage(trackHome.valid && saveTrackHome() ? "Track ALIGN saved" : "Track ALIGN set"); return;
    }
    if (sscanf(line, "TRACK INVERT %d %n", &invert, &end) == 1 && end && !line[end] && (invert == 0 || invert == 1)) {
      trackHome.panInvert = invert != 0;
      queueControlMessage(trackHome.valid && saveTrackHome() ? "Track INVERT saved" : "Track INVERT set"); return;
    }
    end = 0;
    if (sscanf(line, "TRACK LEAD %f %n", &lead, &end) == 1 && end && !line[end]) {
      if (!isfinite(lead) || lead < 0.f || lead > kTrackMaxLeadS) {
        queueControlMessage("Track error: LEAD 0..2.5 s"); return;
      }
      trackPredictSetLead(lead);
      char msg[72];
      snprintf(msg, sizeof(msg), "Track LEAD %.2fs (predict %s)", trackPredict.leadExtraS,
               trackPredict.enabled ? "on" : "off");
      queueControlMessage(msg); return;
    }
    end = 0;
    if (sscanf(line, "TRACK PREDICT %d %n", &pred, &end) == 1 && end && !line[end] && (pred == 0 || pred == 1)) {
      trackPredictSetEnabled(pred != 0);
      queueControlMessage(pred ? "Track PREDICT on" : "Track PREDICT off"); return;
    }
    end = 0;
    if (sscanf(line, "TRACK TARGET %f %f %f %n", &lat, &lon, &alt, &end) == 3 && end && !line[end]) {
      if (!trackHome.valid) { queueControlMessage("Track error: set TRACK HOME first"); return; }
      if (!isfinite(lat) || !isfinite(lon) || !isfinite(alt) || fabsf(lat) > 90.f || fabsf(lon) > 180.f ||
          alt < 0.f || alt > 100000.f) {
        queueControlMessage("Track error: invalid TARGET lat lon alt"); return;
      }
      float aimLat = lat, aimLon = lon, aimAlt = alt;
      trackPredictOnTarget(lat, lon, alt, esp_timer_get_time(), trackHome, &aimLat, &aimLon, &aimAlt);
      const char *err = nullptr;
      if (!applyTrackLatLonAlt(aimLat, aimLon, aimAlt, &err)) {
        queueControlMessage(err ? err : "Track error: aim failed"); return;
      }
      const float azTrue = trackBearingDeg(trackHome.lat, trackHome.lon, aimLat, aimLon);
      const float range = fmaxf(1.f, trackHaversineM(trackHome.lat, trackHome.lon, aimLat, aimLon));
      const float el = atanf((aimAlt - trackHome.alt) / range) * 57.2957795f;
      char msg[112];
      snprintf(msg, sizeof(msg), "Track TARGET az=%.1f el=%.1f lead=%.2f%s",
               azTrue, el, trackPredict.lastLeadS, trackPredict.coasting ? " coast" : "");
      queueControlMessage(msg); return;
    }
    queueControlMessage("Track error: expected HOME|DECL|ALIGN|INVERT|LEAD|PREDICT|TARGET|OFF"); return;
  }
  if (!strncmp(line, "PAN ", 4)) {
    if (!strcmp(line,"PAN SAVE")) {
      stopOutput(0);
      queueControlMessage(savePanSettings() ? "PAN settings saved; output stopped" : "Servo error: PAN save failed"); return;
    }
    if (!strcmp(line,"PAN ZERO")) {
      const auto fb = latestServoFeedback();
      if (!feedbackFresh(fb,0,esp_timer_get_time())) { queueControlMessage("Servo error: fresh PAN feedback required"); return; }
      stopOutput(0); panCalibration.zero += feedbackAngle(fb,0); lastFeedbackUs[0] = 0;
      queueControlMessage("PAN zero applied; use Save PAN settings to persist"); return;
    }
    float ff = NAN, rise = NAN, fall = NAN, search = NAN, searchMax = NAN, brake = NAN; int end = 0;
    const bool cr6 = sscanf(line, "PAN CR CONFIG %f %f %f %f %f %f %n", &ff, &rise, &fall, &search, &searchMax, &brake, &end) == 6 && end && !line[end];
    end = 0;
    const bool cr5 = !cr6 && sscanf(line, "PAN CR CONFIG %f %f %f %f %f %n", &ff, &rise, &fall, &search, &searchMax, &end) == 5 && end && !line[end];
    if ((cr6 || cr5) &&
        isfinite(ff) && ff >= 0 && ff <= 50 && isfinite(rise) && rise >= 1 && rise <= 500 &&
        isfinite(fall) && fall >= 1 && fall <= 1000 && isfinite(search) && search >= 0 && search <= 100 &&
        isfinite(searchMax) && searchMax >= 0 && searchMax <= 200 &&
        (!cr6 || (isfinite(brake) && brake >= 0 && brake <= 2))) {
      stopOutput(0);
      panContinuousUsPerDegPerSec = ff; panPwmRiseUsPerSec = rise; panPwmFallUsPerSec = fall;
      panStartupSearchUsPerSec = search; panStartupSearchMaxUs = searchMax;
      if (cr6) panBrakingConfirmSeconds = brake;
      queueControlMessage("PAN CR tune applied; output stopped; save to persist"); return;
    }
    PanCalibration c; end = 0;
    if (sscanf(line,"PAN CONFIG %f %f %f %f %f %f %f %f %n", &c.neutral,&c.polarity,&c.vmin,&c.vmax,&c.span,&c.zero,&c.amin,&c.amax,&end) != 8 || !end || line[end] || !validPanCalibration(c)) {
      queueControlMessage("Servo error: invalid PAN calibration"); return;
    }
    stopOutput(0); panCalibration = c; lastFeedbackUs[0] = 0;
    queueControlMessage("PAN calibration applied; output stopped; save to persist"); return;
  }
  if (!strncmp(line, "TILT ", 5) && strncmp(line, "TILT IMU ", 9)) {
    if (!strcmp(line, "TILT SWEEP STOP")) { stopOutput(1); queueControlMessage("Tilt sweep cancelled"); return; }
    if (!strcmp(line, "TILT ZERO")) {
      const auto fb = latestServoFeedback();
      if (!feedbackFresh(fb, 1, esp_timer_get_time())) { queueControlMessage("Servo error: fresh TILT feedback required"); return; }
      stopOutput(1); auto calibration = getTiltCalibration();
      calibration.zeroDeg += fb.tiltDegrees;
      if (!setTiltCalibration(calibration)) queueControlMessage("Servo error: zero could not be saved");
      else queueControlMessage("Tilt zero saved; output stopped");
      lastFeedbackUs[1] = 0; return;
    }
    if (!strcmp(line, "TILT SWEEP APPLY")) {
      if (tiltSweep.status != TiltSweepStatus::Complete) { queueControlMessage("Servo error: complete a sweep before applying its range"); return; }
      auto calibration = getTiltCalibration(); calibration.minVolts = tiltSweep.minVolts; calibration.maxVolts = tiltSweep.maxVolts;
      stopOutput(1);
      if (!setTiltCalibration(calibration)) queueControlMessage("Servo error: sweep range could not be saved");
      else queueControlMessage("Tilt measured voltage range saved; set zero afterwards");
      lastFeedbackUs[1] = 0; return;
    }
    TiltCalibration calibration; int end = 0;
    if (sscanf(line, "TILT CONFIG %f %f %f %f %f %n", &calibration.minVolts, &calibration.maxVolts, &calibration.zeroDeg, &calibration.minAngleDeg, &calibration.maxAngleDeg, &end) == 5 && !line[end]) {
      if (!validTiltCalibration(calibration)) { queueControlMessage("Servo error: invalid TILT calibration/limits"); return; }
      stopOutput(1);
      if (!setTiltCalibration(calibration)) queueControlMessage("Servo error: TILT settings could not be saved");
      else queueControlMessage("Tilt calibration and angle limits saved; output stopped");
      lastFeedbackUs[1] = 0; return;
    }
    if (!continuous(1) && !strncmp(line, "TILT SWEEP START ", 17)) {
      queueControlMessage("Servo error: continuous sweep unavailable in position mode"); return;
    }
    float speed = NAN, cap = tiltSweepMaxPulseOffsetUs, minimum = tiltSweepMinimumOffsetUs; int turns = tiltSweepRotations, direction = 0, polarity = tiltContinuousDirection; end = 0;
    const bool explicitTurns = sscanf(line, "TILT SWEEP START %f %d %f %d %f %d %n", &speed, &direction, &cap, &polarity, &minimum, &turns, &end) == 6;
    const bool explicitMinimum = explicitTurns || sscanf(line, "TILT SWEEP START %f %d %f %d %f %n", &speed, &direction, &cap, &polarity, &minimum, &end) == 5;
    const bool explicitPolarity = explicitMinimum || sscanf(line, "TILT SWEEP START %f %d %f %d %n", &speed, &direction, &cap, &polarity, &end) == 4;
    const bool explicitCap = explicitPolarity || sscanf(line, "TILT SWEEP START %f %d %f %n", &speed, &direction, &cap, &end) == 3;
    if (!explicitCap) { end = 0; sscanf(line, "TILT SWEEP START %f %d %n", &speed, &direction, &end); cap = tiltSweepMaxPulseOffsetUs; }
    if (!explicitMinimum) minimum = fminf(minimum, cap);
    if (end && !line[end] && isfinite(minimum) && minimum >= 0 && minimum <= cap && turns >= 1 && turns <= 20 && isfinite(speed) && speed >= 1 && speed <= tiltSweepMaximumSpeedDegPerSec && isfinite(cap) && cap >= 1 && cap <= 1000 && (direction == 1 || direction == -1) && (polarity == 1 || polarity == -1)) {
      const auto fb = latestServoFeedback(); const uint64_t now = esp_timer_get_time();
      if (!armed || estopLatched || !ready[1] || tiltSweep.status == TiltSweepStatus::Running ||
          !fb.deviceUs || now - fb.deviceUs > servoFeedbackTimeoutUs || !isfinite(fb.tiltVolts) || fb.tiltVolts < 0 || fb.tiltVolts > 5) {
        queueControlMessage("Servo error: sweep needs armed TILT and fresh valid pot voltage"); return;
      }
      stopOutput(1); savedSweepSpeedLimit = tiltMaxSpeedDegPerSec; tiltMaxSpeedDegPerSec = speed;
      const auto calibration = getTiltCalibration();
      const float startVolts = isfinite(tiltPotFilter.value) && tiltPotFilter.lastUs && now - tiltPotFilter.lastUs <= servoFeedbackTimeoutUs ? tiltPotFilter.value : fb.tiltVolts;
      tiltSweep.start(startVolts, speed, direction, now, calibration.maxVolts - calibration.minVolts, turns);
      tiltSweep.referenceMinVolts = calibration.minVolts;
      tiltSweep.edgeSeen = direction * (startVolts - (direction > 0 ? calibration.maxVolts : calibration.minVolts)) >= -.05f;
      if (tiltSweep.edgeSeen) tiltSweep.edgeVolts = startVolts;
      tiltSweep.minimumOffsetUs = minimum;
      tiltSweep.pulseOffsetCapUs = cap;
      tiltSweep.pwmPolarity = polarity;
      targetPulseUs[1] = direction > 0 ? SERVO_CONFIG[1].maxPulseUs : SERVO_CONFIG[1].minPulseUs;
      const float initialPulse = tiltSweepStartingPulse(neutralPulse(1), minimum, direction, polarity, SERVO_CONFIG[1].minPulseUs, SERVO_CONFIG[1].maxPulseUs);
      if (!applyPulse(1, initialPulse)) { tiltSweep.status = TiltSweepStatus::Fault; tiltSweep.fault = TiltSweepFault::PwmUpdate; tiltMaxSpeedDegPerSec = savedSweepSpeedLimit; stopOutput(1); }
      else { rampPulseUs[1] = initialPulse; queueControlMessage("Tilt sweep started; angle limits temporarily bypassed"); }
      return;
    }
    queueControlMessage("Servo error: invalid TILT configuration/sweep command"); return;
  }
  if (!strncmp(line, "TILT IMU ", 9)) {
    const auto imu = latestTiltImu(); int axis = -1, end = 0; float zero = NAN, low = NAN, high = NAN; unsigned pmin = 500, pmax = 2500;
    if (!strcmp(line, "TILT IMU ZERO")) {
      if (!imuFresh(imu,esp_timer_get_time())) { queueControlMessage("Servo error: IMU unavailable"); return; }
      stopOutput(1);
      const float delta = imu.angle[tiltImuAxis]-tiltImuZero;
      tiltImuZero += delta; tiltImuMinPulseAngle -= delta; tiltImuMaxPulseAngle -= delta;
      queueControlMessage("TILT IMU zero applied; output stopped"); return;
    }
    int fields = sscanf(line,"TILT IMU CONFIG %d %f %f %f %u %u %n",&axis,&zero,&low,&high,&pmin,&pmax,&end);
    if (fields == 4) { end = 0; fields = sscanf(line,"TILT IMU CONFIG %d %f %f %f %n",&axis,&zero,&low,&high,&end); }
    if ((fields != 4 && fields != 6) || !end || line[end] || axis < 0 || axis > 1 || pmin < 500 || pmax > 2500 || pmin >= pmax ||
        !isfinite(zero) || !isfinite(low) || !isfinite(high) || fabsf(zero)>720 || fabsf(low)>720 || fabsf(high)>720 || fabsf(high-low)<1 || fabsf(high-low)>180) {
      queueControlMessage("Servo error: invalid IMU mapping"); return;
    }
    stopOutput(1); tiltImuAxis = axis; tiltImuZero = zero;
    tiltImuMinPulseAngle = low; tiltImuMaxPulseAngle = high; tiltImuMappedMinPulse = pmin; tiltImuMappedMaxPulse = pmax; tiltImuMappingReady = true;
    queueControlMessage("TILT IMU mapping applied; output stopped"); return;
  }
  if (!strncmp(line, "SERVO PWM SLEW ", 15)) {
    char axis[8] = {}; float rate = NAN, accel = NAN; int end = 0, i = -1;
    if (sscanf(line, "SERVO PWM SLEW %7s %f %f %n", axis, &rate, &accel, &end) != 3 || !end || line[end]) {
      queueControlMessage("Servo error: expected SERVO PWM SLEW AXIS rate_us_s accel_us_s2"); return;
    }
    for (int n = 0; n < 3; ++n) if (!strcmp(axis, SERVO_CONFIG[n].name)) i = n;
    if (i < 0 || !ready[i] || !isfinite(rate) || !isfinite(accel) || rate < 0 || rate > 500 || accel < 0 || accel > 5000) {
      queueControlMessage("Servo error: invalid SERVO PWM SLEW command"); return;
    }
    pwmSlewMaxRateUsPerSec[i] = rate;
    pwmSlewAccelUsPerSec2[i] = accel;
    if (rate <= 0 || accel <= 0) pwmSlewVelocityUsPerSec[i] = 0;
    ControlMessage message = {};
    snprintf(message.text, sizeof(message.text), "Servo pwm slew: %s rate=%.3g accel=%.3g", SERVO_CONFIG[i].name, rate, accel);
    queueControlMessage(message.text);
    return;
  }
  if (!strncmp(line, "SERVO PWM SWEEP ", 16)) {
    char axis[8] = {}; int end = 0;
    int i = -1;
    if (sscanf(line, "SERVO PWM SWEEP %7s STOP %n", axis, &end) == 1 && end && !line[end]) {
      for (int n = 0; n < 3; ++n) if (!strcmp(axis, SERVO_CONFIG[n].name)) i = n;
      if (i < 0 || !ready[i]) { queueControlMessage("Servo error: unknown or unavailable output"); return; }
      const bool wasActive = pwmSweep[i].active;
      stopOutput(i);
      queueControlMessage(wasActive ? "Servo pwm sweep cancelled" : "Servo pwm sweep stopped");
      return;
    }
    unsigned startUs = 0, endUs = 0, frequency = 0;
    float rate = NAN;
    int fields = sscanf(line, "SERVO PWM SWEEP %7s %u %u %f %u %n", axis, &startUs, &endUs, &rate, &frequency, &end);
    if (fields == 4) {
      end = 0;
      fields = sscanf(line, "SERVO PWM SWEEP %7s %u %u %f %n", axis, &startUs, &endUs, &rate, &end);
    }
    for (int n = 0; n < 3; ++n) if (!strcmp(axis, SERVO_CONFIG[n].name)) i = n;
    const auto &c = i >= 0 ? SERVO_CONFIG[i] : SERVO_CONFIG[0];
    if (fields == 4) frequency = c.centerFrequencyHz;
    if (i < 0 || !ready[i] || (fields != 4 && fields != 5) || !end || line[end] ||
        startUs < c.minPulseUs || startUs > c.maxPulseUs || endUs < c.minPulseUs || endUs > c.maxPulseUs ||
        startUs == endUs || !isfinite(rate) || rate < 5 || rate > 200 ||
        frequency < c.minFrequencyHz || frequency > c.maxFrequencyHz ||
        uint64_t(startUs > endUs ? startUs : endUs) * frequency >= 1000000) {
      queueControlMessage("Servo error: invalid SERVO PWM SWEEP command"); return;
    }
    if (!armed || estopLatched) {
      queueControlMessage(estopLatched ? "Servo error: E-stop latched" : "Servo error: servos disabled; enable first"); return;
    }
    if (i == 1 && tiltSweep.status == TiltSweepStatus::Running) {
      queueControlMessage("Servo error: stop TILT pot sweep before PWM sweep"); return;
    }
    stopOutput(i);
    if (frequency != frequencyHz[i] && (i == 1 ? mcpwm_set_frequency(MCPWM_UNIT_0, MCPWM_TIMER_0, frequency) : ledc_set_freq(LEDC_LOW_SPEED_MODE, ledc_timer_t(i), frequency)) != ESP_OK) {
      stopOutput(i); queueControlMessage("Servo error: frequency unavailable"); return;
    }
    if (!(i == 1 ? mcpwm_get_frequency(MCPWM_UNIT_0, MCPWM_TIMER_0) : ledc_get_freq(LEDC_LOW_SPEED_MODE, ledc_timer_t(i)))) {
      stopOutput(i); queueControlMessage("Servo error: frequency readback unavailable"); return;
    }
    frequencyHz[i] = frequency;
    if (!applyPulse(i, float(startUs))) {
      stopOutput(i); queueControlMessage("Servo error: PWM update failed"); return;
    }
    portENTER_CRITICAL(&servoMux);
    manualDirect[i] = true;
    pwmSlewVelocityUsPerSec[i] = 0;
    pwmSweep[i].active = true;
    pwmSweep[i].startUs = float(startUs);
    pwmSweep[i].endUs = float(endUs);
    pwmSweep[i].rateUsPerSec = rate;
    pwmSweep[i].currentUs = float(startUs);
    targetPulseUs[i] = startUs; rampPulseUs[i] = float(startUs);
    portEXIT_CRITICAL(&servoMux);
    ControlMessage message = {};
    snprintf(message.text, sizeof(message.text), "Servo pwm sweep: %s RUNNING", SERVO_CONFIG[i].name);
    queueControlMessage(message.text);
    return;
  }
  if (!strncmp(line, "SERVO RAMP ", 11)) {
    char axis[8] = {}; int enabled = -1, end = 0; float rate = NAN;
    int fields = sscanf(line, "SERVO RAMP %7s %d %f %n", axis, &enabled, &rate, &end);
    if (fields == 2) { end = 0; fields = sscanf(line, "SERVO RAMP %7s %d %n", axis, &enabled, &end); }
    const int i = !strcmp(axis, "PAN") ? 0 : !strcmp(axis, "TILT") ? 1 : -1;
    if (i < 0 || (fields != 2 && fields != 3) || !end || line[end] || (enabled != 0 && enabled != 1) || (fields == 3 && (!isfinite(rate) || rate <= 0 || rate > 360))) {
      queueControlMessage("Servo error: invalid position ramp command"); return;
    }
    if (fields == 3) (i == 0 ? panPositionRampDegPerSec : tiltPositionRampDegPerSec) = rate;
    stopOutput(i);
    (i == 0 ? panPositionRampEnabled : tiltPositionRampEnabled) = enabled;
    queueControlMessage("Servo position ramp applied; output stopped"); return;
  }
  if (!strncmp(line, "SERVO DEADBAND ", 15)) {
    char axis[8] = {}; int end = 0; float plus = NAN, minus = NAN;
    const int fields = sscanf(line, "SERVO DEADBAND %7s %f %f %n", axis, &plus, &minus, &end);
    const int i = !strcmp(axis, "PAN") ? 0 : !strcmp(axis, "TILT") ? 1 : -1;
    if (i < 0 || fields != 3 || !end || line[end] || !isfinite(plus) || !isfinite(minus) || plus < 0 || plus > 1000 || minus < 0 || minus > 1000) {
      queueControlMessage("Servo error: invalid deadband command"); return;
    }
    stopOutput(i);
    (i == 0 ? panPositiveDeadbandUs : tiltPositiveDeadbandUs) = plus;
    (i == 0 ? panNegativeDeadbandUs : tiltNegativeDeadbandUs) = minus;
    queueControlMessage("Servo deadband applied; output stopped"); return;
  }
  if (!strncmp(line, "SERVO BREAKAWAY ", 16)) {
    char axis[8] = {}; int end = 0; float offset = NAN, durationMs = NAN;
    const int fields = sscanf(line, "SERVO BREAKAWAY %7s %f %f %n", axis, &offset, &durationMs, &end);
    if (strcmp(axis, "PAN") || fields != 3 || !end || line[end] || !validPanBreakaway(offset, durationMs)) {
      queueControlMessage("Servo error: expected SERVO BREAKAWAY PAN offset_us duration_ms"); return;
    }
    stopOutput(0);
    panPositionBreakawayOffsetUs = offset;
    panPositionBreakawayDurationMs = durationMs;
    queueControlMessage("Servo breakaway applied; output stopped; save to persist"); return;
  }
  if (!strncmp(line, "SERVO SCHEDULE ", 15)) {
    char axis[8] = {}; int end = 0;
    float kpNear = NAN, capNear = NAN, scheduleDeg = NAN, brkMinScale = NAN, settleDeg = NAN;
    const int fields = sscanf(line, "SERVO SCHEDULE %7s %f %f %f %f %f %n", axis, &kpNear, &capNear, &scheduleDeg, &brkMinScale, &settleDeg, &end);
    if (strcmp(axis, "PAN") || fields != 6 || !end || line[end] ||
        !validPanSchedule(kpNear, capNear, scheduleDeg, brkMinScale, settleDeg)) {
      queueControlMessage("Servo error: expected SERVO SCHEDULE PAN kp_near cap_near schedule_deg brk_min_scale settle_deg"); return;
    }
    stopOutput(0);
    panPositionKpNear = kpNear;
    panPositionCapNearUs = capNear;
    panPositionScheduleDeg = scheduleDeg;
    panPositionBreakawayMinScale = brkMinScale;
    panPositionSettleDeg = settleDeg;
    queueControlMessage("Servo schedule applied; output stopped; save to persist"); return;
  }
  if (!strncmp(line, "SERVO FEEDBACK ", 15)) {
    char axis[8] = {}, mode[12] = {}; int end = 0;
    if (sscanf(line, "SERVO FEEDBACK %7s %11s %n", axis, mode, &end) != 2 || !end || line[end] || strcmp(axis, "PAN")) {
      queueControlMessage("Servo error: expected SERVO FEEDBACK PAN POT|MAG"); return;
    }
    PanPositionFeedback next = PanPositionFeedback::Pot;
    if (!strcmp(mode, "POT") || !strcmp(mode, "0")) next = PanPositionFeedback::Pot;
    else if (!strcmp(mode, "MAG") || !strcmp(mode, "1")) next = PanPositionFeedback::Mag;
    else { queueControlMessage("Servo error: feedback mode must be POT or MAG (FUSION not implemented)"); return; }
    stopOutput(0);
    panPositionFeedback = next;
    panMagHeadingFilter.reset();
    queueControlMessage(next == PanPositionFeedback::Mag
      ? "Servo PAN feedback MAG; output stopped; save to persist"
      : "Servo PAN feedback POT; output stopped; save to persist");
    return;
  }
  if (!strncmp(line, "SERVO MAGSOFT ", 14)) {
    int end = 0;
    if (!strcmp(line, "SERVO MAGSOFT CLEAR") || !strcmp(line, "SERVO MAGSOFT OFF")) {
      panMagSoftIron.enabled = false;
      panMagSoftIron.cx = panMagSoftIron.cy = 0;
      panMagSoftIron.sx = panMagSoftIron.sy = 1;
      panMagHeadingFilter.reset();
      queueControlMessage("Servo mag soft-iron cleared; save PAN to persist"); return;
    }
    float cx = NAN, cy = NAN, sx = NAN, sy = NAN;
    if (sscanf(line, "SERVO MAGSOFT %f %f %f %f %n", &cx, &cy, &sx, &sy, &end) != 4 || !end || line[end] ||
        !validPanMagSoftIron(cx, cy, sx, sy)) {
      queueControlMessage("Servo error: expected SERVO MAGSOFT cx cy sx sy | CLEAR"); return;
    }
    panMagSoftIron.enabled = true;
    panMagSoftIron.cx = cx; panMagSoftIron.cy = cy;
    panMagSoftIron.sx = sx; panMagSoftIron.sy = sy;
    panMagHeadingFilter.reset();
    queueControlMessage("Servo mag soft-iron applied; save PAN to persist"); return;
  }
  if (!strncmp(line, "SERVO PID ", 10) || !strncmp(line, "SERVO POSITION ", 15)) {
    char axis[8] = {}; int end = 0;
    const bool gains = !strncmp(line, "SERVO PID ", 10);
    PositionPidConfig config = {}; float target = NAN;
    const int fields = gains ? sscanf(line, "SERVO PID %7s %f %f %f %f %f %f %n", axis, &config.kp, &config.ki, &config.kd, &config.integralLimit, &config.outputLimit, &config.tolerance, &end) :
      sscanf(line, "SERVO POSITION %7s %f %n", axis, &target, &end);
    const int i = !strcmp(axis, "PAN") ? 0 : !strcmp(axis, "TILT") ? 1 : -1;
    if (i < 0 || fields != (gains ? 7 : 2) || !end || line[end] || (gains && !validPositionPid(config))) {
      queueControlMessage("Servo error: invalid position/PID command"); return;
    }
    if (gains) {
      stopOutput(i); // Gain edits never start or continue motion with changed gains.
      (i == 0 ? panPositionPidConfig : tiltPositionPidConfig) = config;
      queueControlMessage("Servo position PID applied; output stopped"); return;
    }
    const char *err = nullptr;
    if (!applyPositionTarget(i, target, &err)) {
      queueControlMessage(err ? err : "Servo error: position requires enabled output, fresh feedback, valid limits");
      return;
    }
    queueControlMessage(positionBreakaway[i].active ? "Servo position target applied; breakaway spike armed" : "Servo position target applied");
    return;
  }
  if (!strncmp(line, "SERVO OVERSPEED ", 16)) {
    char axis[8] = {}; int value = -1, end = 0;
    if (sscanf(line, "SERVO OVERSPEED %7s %d %n", axis, &value, &end) != 2 || !end || line[end] || (value != 0 && value != 1) || (strcmp(axis, "PAN") && strcmp(axis, "TILT"))) {
      queueControlMessage("Servo error: expected SERVO OVERSPEED PAN/TILT 0/1"); return;
    }
    const int i = !strcmp(axis, "PAN") ? 0 : 1;
    (i == 0 ? panOverspeedFaultEnabled : tiltOverspeedFaultEnabled) = value;
    trackingFaultStartedUs[i] = 0;
    queueControlMessage("Servo overspeed fault setting applied"); return;
  }
  if (!strncmp(line, "SERVO SPEED ", 12)) {
    char axis[8] = {}; float speed = NAN; int end = 0;
    if (sscanf(line, "SERVO SPEED %7s %f %n", axis, &speed, &end) != 2 || line[end] || !isfinite(speed) || speed < 0 || speed > 360) {
      queueControlMessage("Servo error: expected SERVO SPEED PAN/TILT 0..360 deg/s"); return;
    }
    int i = !strcmp(axis, "PAN") ? 0 : !strcmp(axis, "TILT") ? 1 : -1;
    if (i < 0) { queueControlMessage("Servo error: speed limiting is calibrated for PAN and TILT"); return; }
    if (i == 1 && tiltSweep.status == TiltSweepStatus::Running) { queueControlMessage("Servo error: stop TILT sweep before changing speed"); return; }
    // Changing the speed never arms, enables, or starts a stopped output.
    if (i == 0) panMaxSpeedDegPerSec = speed; else tiltMaxSpeedDegPerSec = speed;
    if (manualDirect[i]) { queueControlMessage("Servo speed saved; manual PWM unchanged"); return; }
    if (speed == 0 && continuous(i)) stopOutput(i);
    else if (speed == 0) { targetPulseUs[i] = pulseUs[i]; rampPulseUs[i] = pulseUs[i]; trajectoryVelocity[i] = 0; }
    queueControlMessage("Servo speed setting applied"); return;
  }
  char axis[8] = {}, tail[8] = {};
  unsigned long pulse = 0, frequency = 0;
  int consumed = 0;
  int i = -1;
  const bool directCommand = !strncmp(line, "SERVO RAW ", 10);
  const bool continuousCommand = !strncmp(line, "SERVO CR ", 9);
  const char *request = directCommand ? line + 10 : continuousCommand ? line + 9 : line + 6;
  if (strncmp(line, "SERVO ", 6) || sscanf(request, "%7s", axis) != 1) { queueControlMessage("Servo error: invalid command"); return; }
  for (int n = 0; n < 3; ++n) if (!strcmp(axis, SERVO_CONFIG[n].name)) i = n;
  if (i < 0 || !ready[i]) { queueControlMessage("Servo error: unknown or unavailable output"); return; }
  if (sscanf(request, "%7s %7s %n", axis, tail, &consumed) == 2 &&
      !strcmp(tail, "OFF") && request[consumed] == '\0') {
    stopOutput(i); acknowledge(i); return;
  }
  if (i == 1 && tiltSweep.status == TiltSweepStatus::Running) { queueControlMessage("Servo error: stop TILT sweep before commanding TILT"); return; }
  consumed = 0;
  if (!armed || estopLatched) {
    queueControlMessage(estopLatched ? "Servo error: E-stop latched" : "Servo error: servos disabled; enable first"); return;
  }
  if (!directCommand && continuousCommand != continuous(i)) {
    queueControlMessage("Servo error: command mode mismatch; update dashboard for continuous mode"); return;
  }
  float requestedLimit = !directCommand && i < 2 ? speedLimit(i) : 0;
  const bool hasLimit = continuousCommand && sscanf(request, "%7s %lu %lu %f %n", axis, &pulse, &frequency, &requestedLimit, &consumed) == 4;
  if (!hasLimit) {
    consumed = 0;
    if (sscanf(request, "%7s %lu %lu %n", axis, &pulse, &frequency, &consumed) != 3) {
      queueControlMessage("Servo error: expected axis pulse_us frequency_hz [speed_limit]"); return;
    }
    requestedLimit = !directCommand && i < 2 ? speedLimit(i) : 0;
  }
  if (request[consumed] || !isfinite(requestedLimit) || requestedLimit < 0 || requestedLimit > 360) {
    queueControlMessage("Servo error: invalid command or speed limit"); return;
  }
  const auto &c = SERVO_CONFIG[i];
  if (pulse < c.minPulseUs || pulse > c.maxPulseUs || frequency < c.minFrequencyHz || frequency > c.maxFrequencyHz ||
      uint64_t(pulse) * frequency >= 1000000) {
    queueControlMessage("Servo error: command outside configured limits"); return;
  }
  float startPulse = pulse;
  if (i < 2) { positionActive[i] = false; positionPid[i].reset(); }
  const bool limited = i < 2 && requestedLimit > 0;
  const bool pwmSlew = pwmSlewMaxRateUsPerSec[i] > 0 && pwmSlewAccelUsPerSec2[i] > 0;
  if (!directCommand && continuous(i)) {
    if ((limited || i == 1) && pulse != neutralPulse(i) && !feedbackFresh(latestServoFeedback(), i, esp_timer_get_time())) {
      queueControlMessage("Servo error: continuous speed control requires fresh feedback"); return;
    }
    // Limited CR keeps prior pulse; unregulated CR uses PWM trapezoid when configured.
    if (limited) startPulse = enabled[i] ? pulseUs[i] : neutralPulse(i);
    else if (pwmSlew && enabled[i]) startPulse = rampPulseUs[i];
    else startPulse = float(pulse);
    if (pulse == neutralPulse(i) && !pwmSlew) { startPulse = neutralPulse(i); trajectoryVelocity[i] = 0; speedControl[i].reset(); }
    if (pulse == neutralPulse(i)) { trajectoryVelocity[i] = 0; speedControl[i].reset(); }
  }
  if (directCommand && pwmSlew && enabled[i]) startPulse = i == 1 ? actualTiltPulseUs : rampPulseUs[i];
  if (!pwmSlew) pwmSlewVelocityUsPerSec[i] = 0;
  if (!directCommand && limited && !continuous(i)) {
    const auto fb = latestServoFeedback();
    if (!feedbackFresh(fb, i, esp_timer_get_time())) {
      queueControlMessage("Servo error: speed limit requires fresh valid feedback"); return;
    }
    if (!isfinite(minAngle(i)) || !isfinite(maxAngle(i)) || minAngle(i) == maxAngle(i)) {
      queueControlMessage("Servo error: invalid PWM angle calibration"); return;
    }
    startPulse = enabled[i] ? rampPulseUs[i] : deviceAngleToPulse(feedbackAngle(fb, i), c.minPulseUs, c.maxPulseUs, minAngle(i), maxAngle(i));
    if (!isfinite(startPulse) || startPulse < c.minPulseUs || startPulse > c.maxPulseUs) {
      queueControlMessage("Servo error: feedback outside PWM angle calibration; edit servo_motion_config.h"); return;
    }
  }
  // ESP-IDF returns ESP_OK (zero), unlike Arduino ledcSetup's frequency return.
  // Pulse changes must not reconfigure an unchanged timer frequency.
  if (frequency != frequencyHz[i] && (i == 1 ? mcpwm_set_frequency(MCPWM_UNIT_0, MCPWM_TIMER_0, frequency) : ledc_set_freq(LEDC_LOW_SPEED_MODE, ledc_timer_t(i), frequency)) != ESP_OK) {
    stopOutput(i); queueControlMessage("Servo error: frequency unavailable"); return;
  }
  const uint32_t actualHz = i == 1 ? mcpwm_get_frequency(MCPWM_UNIT_0, MCPWM_TIMER_0) : ledc_get_freq(LEDC_LOW_SPEED_MODE, ledc_timer_t(i));
  if (!actualHz) {
    stopOutput(i); queueControlMessage("Servo error: frequency readback unavailable"); return;
  }
  // get_freq() truncates fractional hertz. Use the requested nominal period;
  // divider quantization is much smaller than truncating 49.999 Hz to 49 Hz.
  frequencyHz[i] = frequency;
  if (!applyPulse(i, startPulse)) {
    stopOutput(i); queueControlMessage("Servo error: PWM update failed"); return;
  }
  portENTER_CRITICAL(&servoMux);
  if (hasLimit) { if (i == 0) panMaxSpeedDegPerSec = requestedLimit; else tiltMaxSpeedDegPerSec = requestedLimit; }
  manualDirect[i] = directCommand;
  pwmSweep[i].active = false;
  targetPulseUs[i] = pulse; rampPulseUs[i] = startPulse;
  portEXIT_CRITICAL(&servoMux);
  acknowledge(i);
}

}  // namespace servo_internal
