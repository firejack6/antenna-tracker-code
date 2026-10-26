#include "servo_internal.h"
#include "status_frame.h"
#include "servo_feedback.h"
#include "tilt_imu.h"
#include "tilt_calibration.h"
#include "sampling_config.h"
#include "network_config.h"
#include "acquisition.h"
#include <string.h>
#include <math.h>

using namespace servo_internal;

void fillServoStatus(StatusFrame &frame) {
  bool active[3]; uint32_t pulses[3], frequencies[3];
  bool canCommand, stopped;
  portENTER_CRITICAL(&servoMux);
  memcpy(active, enabled, sizeof(active)); memcpy(pulses, pulseUs, sizeof(pulses)); memcpy(frequencies, frequencyHz, sizeof(frequencies));
  canCommand = armed; stopped = estopLatched;
  portEXIT_CRITICAL(&servoMux);
  frame.armed = canCommand; frame.estop = stopped;
  for (int i = 0; i < 3; ++i) {
    const auto &c = SERVO_CONFIG[i];
    auto &s = frame.servos[i];
    s.gpio = c.gpio; s.pmin = c.minPulseUs; s.pcenter = c.centerPulseUs; s.pmax = c.maxPulseUs;
    s.fmin = c.minFrequencyHz; s.fcenter = c.centerFrequencyHz; s.fmax = c.maxFrequencyHz;
    s.pulse = pulses[i]; s.freq = frequencies[i]; s.enable = active[i]; s.ready = ready[i];
    s.umin = continuous(i) ? int32_t(neutralPulse(i) - 100) : int32_t(c.presetMinPulseUs);
    s.ucenter = continuous(i) ? int32_t(neutralPulse(i)) : int32_t(c.presetCenterPulseUs);
    s.umax = continuous(i) ? int32_t(neutralPulse(i) + 100) : int32_t(c.presetMaxPulseUs);
    s.mode = continuous(i); s.neutral = continuous(i) ? int32_t(neutralPulse(i)) : 0; s.raw = manualDirect[i];
    if (i >= 2) continue;
    auto &m = frame.motion[i];
    m.angle = measuredDegrees[i]; m.speed = measuredSpeed[i]; m.limit = speedLimit(i);
    m.target = targetPulseUs[i];
    m.slew_rate = pwmSlewMaxRateUsPerSec[i]; m.slew_accel = pwmSlewAccelUsPerSec2[i];
    const bool pwmMoving = fabsf(rampPulseUs[i] - float(targetPulseUs[i])) > 0.5f;
    m.moving = active[i] && (manualDirect[i] || !continuous(i) ? pwmMoving
      : (targetPulseUs[i] != neutralPulse(i) || pwmMoving));
    m.minangle = positionLowerAngle(i); m.maxangle = positionUpperAngle(i);
    m.commandspeed = continuousDemandSpeed[i];
    m.osfault = i == 0 ? panOverspeedFaultEnabled : tiltOverspeedFaultEnabled;
    const auto &spd = speedControl[i];
    const int direction = usesImu(i) ? (tiltImuMaxPulseAngle > tiltImuMinPulseAngle ? 1 : -1) : continuousDirection(i);
    auto &p = frame.pid[i];
    if (positionActive[i]) {
      const auto &pp = positionPid[i];
      p.setpoint = positionSetpoint[i]; p.error = pp.error;
      p.p = pp.p * direction; p.i = pp.integral * direction; p.d = pp.d * direction;
      p.ff = usesImu(i) ? angularPositionPulse(i, positionSetpoint[i]) - neutralPulse(i) : pp.deadband * direction;
      p.startup = 0;
      p.request = usesImu(i) ? angularPositionPulse(i, positionSetpoint[i]) - neutralPulse(i) + pp.request * direction : pp.request * direction;
      p.output = active[i] ? (i == 1 ? actualTiltPulseUs : float(pulses[i])) - neutralPulse(i) : 0;
      p.active = active[i]; p.phase = 0; p.mode = 1;
    } else {
      p.setpoint = trajectoryVelocity[i]; p.error = spd.errorTerm;
      p.p = direction * spd.pTerm; p.i = direction * spd.iTerm; p.d = 0;
      p.ff = direction * spd.feedforwardTerm; p.startup = direction * spd.startupTerm;
      p.request = direction * spd.requestedOffset;
      p.output = active[i] ? (i == 1 ? actualTiltPulseUs : float(pulses[i])) - neutralPulse(i) : 0;
      p.active = active[i] && speedLimit(i) > 0; p.phase = int(spd.phase); p.mode = 0;
    }
    const auto &config = i == 0 ? panPositionPidConfig : tiltPositionPidConfig;
    auto &pos = frame.position[i];
    pos.target = positionTarget[i]; pos.active = positionActive[i];
    pos.kp = config.kp; pos.ki = config.ki; pos.kd = config.kd;
    pos.ilimit = config.integralLimit; pos.cap = config.outputLimit; pos.tolerance = config.tolerance;
    pos.dbplus = i == 0 ? panPositiveDeadbandUs : tiltPositiveDeadbandUs;
    pos.dbminus = i == 0 ? panNegativeDeadbandUs : tiltNegativeDeadbandUs;
    pos.ramp = i == 0 ? panPositionRampEnabled : tiltPositionRampEnabled;
    pos.ramprate = i == 0 ? panPositionRampDegPerSec : tiltPositionRampDegPerSec;
  }
  frame.pan_neutral = panCalibration.neutral; frame.pan_polarity = panCalibration.polarity;
  frame.pan_vmin = panCalibration.vmin; frame.pan_vmax = panCalibration.vmax;
  frame.pan_span = panCalibration.span; frame.pan_zero = panCalibration.zero;
  frame.pan_amin = panCalibration.amin; frame.pan_amax = panCalibration.amax;
  const auto imu = latestTiltImu();
  frame.imu_angle = imu.angle[tiltImuAxis] - tiltImuZero; frame.imu_speed = imu.speed[tiltImuAxis];
  frame.imu_raw = imu.angle[tiltImuAxis]; frame.imu_zero = tiltImuZero;
  frame.imu_axis = tiltImuAxis; frame.imu_ready = tiltImuMappingReady; frame.imu_active = usesImu(1);
  frame.imu_amin = tiltImuMinPulseAngle; frame.imu_amax = tiltImuMaxPulseAngle;
  frame.imu_us = imu.deviceUs; frame.imu_pmin = tiltImuMappedMinPulse; frame.imu_pmax = tiltImuMappedMaxPulse;
  const auto calibration = getTiltCalibration(); const auto feedback = latestServoFeedback();
  frame.tilt_vmin = calibration.minVolts; frame.tilt_vmax = calibration.maxVolts;
  frame.tilt_zero = calibration.zeroDeg; frame.tilt_amin = calibration.minAngleDeg; frame.tilt_amax = calibration.maxAngleDeg;
  frame.tilt_volts = feedback.tiltVolts; frame.tilt_sweep = int(tiltSweep.status);
  frame.tilt_smin = tiltSweep.minVolts; frame.tilt_smax = tiltSweep.maxVolts;
  frame.tilt_progress = tiltSweep.progressDeg; frame.tilt_reason = int(tiltSweep.fault);
  frame.tilt_cap = tiltSweep.pulseOffsetCapUs;
  frame.tilt_poldir = tiltSweep.observedDirection * tiltSweep.requestedDirection * tiltSweep.pwmPolarity;
  frame.tilt_filtered = tiltPotFilter.value; frame.tilt_minpwm = tiltSweep.minimumOffsetUs;
  frame.tilt_rotations = tiltSweep.rotations; frame.tilt_wrap = tiltSweep.rolloverActive;

  frame.cfg_pan_speed = panMaxSpeedDegPerSec; frame.cfg_tilt_speed = tiltMaxSpeedDegPerSec;
  frame.cfg_pan_ramp_rate = panPositionRampDegPerSec; frame.cfg_tilt_ramp_rate = tiltPositionRampDegPerSec;
  frame.cfg_pan_dbplus = panPositiveDeadbandUs; frame.cfg_pan_dbminus = panNegativeDeadbandUs;
  frame.cfg_tilt_dbplus = tiltPositiveDeadbandUs; frame.cfg_tilt_dbminus = tiltNegativeDeadbandUs;
  frame.cfg_pan_kp = panPositionPidConfig.kp; frame.cfg_pan_ki = panPositionPidConfig.ki; frame.cfg_pan_kd = panPositionPidConfig.kd;
  frame.cfg_tilt_kp = tiltPositionPidConfig.kp; frame.cfg_tilt_ki = tiltPositionPidConfig.ki; frame.cfg_tilt_kd = tiltPositionPidConfig.kd;
  frame.cfg_pan_ramp = panPositionRampEnabled; frame.cfg_tilt_ramp = tiltPositionRampEnabled;
  frame.cfg_pan_osfault = panOverspeedFaultEnabled; frame.cfg_tilt_osfault = tiltOverspeedFaultEnabled;
  frame.cfg_pan_ff = panContinuousUsPerDegPerSec; frame.cfg_pan_rise = panPwmRiseUsPerSec;
  frame.cfg_pan_fall = panPwmFallUsPerSec; frame.cfg_pan_search = panStartupSearchUsPerSec;
  frame.cfg_pan_search_max = panStartupSearchMaxUs; frame.cfg_pan_brake = panBrakingConfirmSeconds;
  frame.cfg_adc_sample_hz = adcSampleHz;
  frame.cfg_adc_stream = adcStreamEnabled() ? 1 : 0;
  frame.cfg_wifi_ap = WIFI_ACCESS_POINT ? 1 : 0;
}

void printServoStates() {
  // Status telemetry is emitted as ATS1 from serviceTelemetry via fillServoStatus + sendStatusFrame.
}
