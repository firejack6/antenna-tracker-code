#include "servo_internal.h"
#include "network_transport.h"
#include <Arduino.h>
#include <driver/ledc.h>
#include <driver/mcpwm.h>
#include <string.h>
#include "servo_config.h"
#include "servo_control.h"
#include "acquisition.h"
#include "servo_feedback.h"
#include "tilt_imu.h"
#include "servo_motion_config.h"
#include "servo_motion_math.h"
#include "tilt_calibration.h"
#include "servo_feedback_filter.h"
#include "continuous_speed_control.h"
#include <esp_timer.h>
#include "pan_calibration.h"
#include "track_geo.h"

extern bool handleSensorCommand(const char *line);
float panMaxSpeedDegPerSec = panDefaultMaxSpeedDegPerSec;
float tiltMaxSpeedDegPerSec = tiltDefaultMaxSpeedDegPerSec;
float pwmSlewMaxRateUsPerSec[3] = {
  panPwmSlewRateDefaultUsPerSec, tiltPwmSlewRateDefaultUsPerSec, s3PwmSlewRateDefaultUsPerSec};
float pwmSlewAccelUsPerSec2[3] = {
  panPwmSlewAccelDefaultUsPerSec2, tiltPwmSlewAccelDefaultUsPerSec2, s3PwmSlewAccelDefaultUsPerSec2};
bool panOverspeedFaultEnabled = true;
bool tiltOverspeedFaultEnabled = true;
float panPositiveDeadbandUs = panPositiveDeadbandDefaultUs, panNegativeDeadbandUs = panNegativeDeadbandDefaultUs;
float tiltPositiveDeadbandUs = tiltPositiveDeadbandDefaultUs, tiltNegativeDeadbandUs = tiltNegativeDeadbandDefaultUs;
float panContinuousUsPerDegPerSec = panContinuousUsPerDegPerSecDefault;
float panPwmRiseUsPerSec = panPwmRiseDefaultUsPerSec, panPwmFallUsPerSec = panPwmFallDefaultUsPerSec;
float panStartupSearchUsPerSec = panStartupSearchDefaultUsPerSec, panStartupSearchMaxUs = panStartupSearchMaxDefaultUs;
float panBrakingConfirmSeconds = panBrakingConfirmDefaultSeconds;
float panPositionRampDegPerSec = positionRampDefaultDegPerSec, tiltPositionRampDegPerSec = positionRampDefaultDegPerSec;
bool panPositionRampEnabled = positionRampDefaultEnabled, tiltPositionRampEnabled = positionRampDefaultEnabled;
PositionPidConfig panPositionPidConfig = panPositionPidDefaults;
PositionPidConfig tiltPositionPidConfig = tiltPositionPidDefaults;
float panPositionBreakawayOffsetUs = panPositionBreakawayOffsetDefaultUs;
float panPositionBreakawayDurationMs = panPositionBreakawayDurationDefaultMs;
float panPositionKpNear = panPositionKpNearDefault;
float panPositionCapNearUs = panPositionCapNearDefaultUs;
float panPositionScheduleDeg = panPositionScheduleDefaultDeg;
float panPositionBreakawayMinScale = panPositionBreakawayMinScaleDefault;
float panPositionSettleDeg = panPositionSettleDefaultDeg;
PanPositionFeedback panPositionFeedback = panPositionFeedbackDefault;
PanMagSoftIron panMagSoftIron;
PanMagHeadingFilter panMagHeadingFilter;

namespace servo_internal {
TrackHome trackHome;
PanCalibration panCalibration;
QueueHandle_t messages = nullptr;
portMUX_TYPE servoMux = portMUX_INITIALIZER_UNLOCKED;
bool ready[3] = {}, enabled[3] = {}, manualDirect[3] = {};
bool armed = false, estopLatched = false;
ServoControlHealth controlHealth;
TiltSweep tiltSweep;
PwmSweep pwmSweep[3] = {};
float pwmSlewVelocityUsPerSec[3] = {};
ServoPotFilter tiltPotFilter;
ServoVelocityWindow tiltVelocityWindow;
ConsecutiveFeedbackFault overspeedConfirmation[2];
uint64_t invalidVelocityStartedUs[2] = {};
uint64_t lastValidTiltPotUs = 0;
ServoVelocityPotFilter tiltVelocityPotFilter;
float savedSweepSpeedLimit = 0;
uint32_t pulseUs[3] = {}, frequencyHz[3] = {};
float actualTiltPulseUs = 1500;
uint32_t targetPulseUs[3] = {};
float rampPulseUs[3] = {}, measuredDegrees[2] = {NAN, NAN}, measuredSpeed[2] = {NAN, NAN};
float filteredDegrees[2] = {NAN, NAN};
uint64_t lastFeedbackUs[2] = {}, lastMotionUs = 0;
float trajectoryVelocity[2] = {};
uint64_t trackingFaultStartedUs[2] = {};
float continuousDemandSpeed[2] = {};
ContinuousSpeedControl speedControl[2];
PositionPid positionPid[2];
bool positionActive[2] = {};
float positionTarget[2] = {}, positionSetpoint[2] = {};
PositionBreakaway positionBreakaway[2] = {};
int tiltImuAxis = tiltImuAxisDefault;
bool tiltImuMappingReady = tiltImuMappingDefaultReady;
float tiltImuZero = tiltImuZeroDefaultDeg;
unsigned tiltImuMappedMinPulse = tiltImuMappedMinPulseDefault, tiltImuMappedMaxPulse = tiltImuMappedMaxPulseDefault;
float tiltImuMinPulseAngle = tiltImuAngleAtMinPulseDefault, tiltImuMaxPulseAngle = tiltImuAngleAtMaxPulseDefault;
bool usesImu(int i) { return i == 1 && !tiltContinuousRotation && tiltImuControlEnabled; }
bool imuFresh(const TiltImuSample &s, uint64_t now) {
  return s.deviceUs && now >= s.deviceUs && now-s.deviceUs <= servoFeedbackTimeoutUs && isfinite(s.angle[tiltImuAxis]) && isfinite(s.speed[tiltImuAxis]);
}
float previousFeedbackAngle[2] = {NAN, NAN};
bool continuous(int i) { return i == 0 ? panContinuousRotation : i == 1 && tiltContinuousRotation; }
unsigned neutralPulse(int i) { return i == 0 ? unsigned(lroundf(panCalibration.neutral)) : tiltNeutralPulseUs; }
int continuousDirection(int i) { return i == 0 ? int(panCalibration.polarity) : (tiltSweep.status == TiltSweepStatus::Running ? tiltSweep.pwmPolarity : tiltContinuousDirection); }
float continuousFeedforward(int i) { return i == 0 ? panContinuousUsPerDegPerSec : tiltContinuousUsPerDegPerSec; }
float speedLimit(int i) { return i == 0 ? panMaxSpeedDegPerSec : tiltMaxSpeedDegPerSec; }
float minAngle(int i) { return i == 0 ? panAngleAtMinPulseDeg : tiltAngleAtMinPulseDeg; }
float maxAngle(int i) { return i == 0 ? panAngleAtMaxPulseDeg : tiltAngleAtMaxPulseDeg; }
float positionLowerAngle(int i) {
  if (i == 0) return panCalibration.amin;
  if (usesImu(i)) return fminf(tiltImuMinPulseAngle,tiltImuMaxPulseAngle);
  const auto c = getTiltCalibration();
  const float mapping = fminf(minAngle(i), maxAngle(i)) - (i == 1 ? c.zeroDeg : 0);
  return i == 1 ? (continuous(i) ? c.minAngleDeg : fmaxf(c.minAngleDeg, mapping)) : mapping;
}
float positionUpperAngle(int i) {
  if (i == 0) return panCalibration.amax;
  if (usesImu(i)) return fmaxf(tiltImuMinPulseAngle,tiltImuMaxPulseAngle);
  const auto c = getTiltCalibration();
  const float mapping = fmaxf(minAngle(i), maxAngle(i)) - (i == 1 ? c.zeroDeg : 0);
  return i == 1 ? (continuous(i) ? c.maxAngleDeg : fminf(c.maxAngleDeg, mapping)) : mapping;
}
float angularPositionPulse(int i, float relativeAngle) {
  const auto &c = SERVO_CONFIG[i];
  if (usesImu(i)) return deviceAngleToPulse(relativeAngle,tiltImuMappedMinPulse,tiltImuMappedMaxPulse,tiltImuMinPulseAngle,tiltImuMaxPulseAngle);
  const float zero = i == 1 ? getTiltCalibration().zeroDeg : 0;
  return deviceAngleToPulse(relativeAngle + zero, c.minPulseUs, c.maxPulseUs, minAngle(i), maxAngle(i));
}
float feedbackAngle(const ServoFeedback &fb, int i) { return i == 0 ? panAngleFromVolts(fb.panVolts, panCalibration) : fb.tiltDegrees; }
bool feedbackFresh(const ServoFeedback &fb, int i, uint64_t now) {
  return fb.deviceUs && now >= fb.deviceUs && now - fb.deviceUs <= servoFeedbackTimeoutUs && isfinite(feedbackAngle(fb, i));
}
bool applyPulse(int i, float pulse) {
  if (i == 1) {
    // 3.2 MHz timer: 0.3125-us pulse steps at either 50 or 100 Hz.
    // Preserve fractional controller output instead of rounding to whole us.
    const float quantized = roundf(pulse * 3.2f) / 3.2f;
    if (mcpwm_set_duty(MCPWM_UNIT_0, MCPWM_TIMER_0, MCPWM_OPR_A,
          quantized * frequencyHz[i] / 10000.0f) != ESP_OK ||
        mcpwm_set_duty_type(MCPWM_UNIT_0, MCPWM_TIMER_0, MCPWM_OPR_A, MCPWM_DUTY_MODE_0) != ESP_OK) return false;
    actualTiltPulseUs = quantized;
    portENTER_CRITICAL(&servoMux); pulseUs[i] = uint32_t(lroundf(quantized)); enabled[i] = true; portEXIT_CRITICAL(&servoMux);
    return true;
  }
  const uint32_t duty = (uint64_t(lroundf(pulse)) * frequencyHz[i] * 16384 + 500000) / 1000000;
  if (duty >= 16384 || ledc_set_duty(LEDC_LOW_SPEED_MODE, ledc_channel_t(i), duty) != ESP_OK ||
      ledc_update_duty(LEDC_LOW_SPEED_MODE, ledc_channel_t(i)) != ESP_OK) return false;
  portENTER_CRITICAL(&servoMux); pulseUs[i] = pulse; enabled[i] = true; portEXIT_CRITICAL(&servoMux);
  return true;
}
bool validConfig(const ServoConfig &c) {
  return c.minPulseUs > 0 && c.minPulseUs <= c.centerPulseUs && c.centerPulseUs <= c.maxPulseUs &&
    c.minFrequencyHz > 0 && c.minFrequencyHz <= c.centerFrequencyHz && c.centerFrequencyHz <= c.maxFrequencyHz &&
    uint64_t(c.maxPulseUs) * c.maxFrequencyHz < 1000000 &&
    c.minPulseUs <= c.presetMinPulseUs && c.presetMinPulseUs <= c.presetCenterPulseUs &&
    c.presetCenterPulseUs <= c.presetMaxPulseUs && c.presetMaxPulseUs <= c.maxPulseUs;
}
void stopOutput(int i) {
  manualDirect[i] = false;
  pwmSweep[i].active = false;
  pwmSlewVelocityUsPerSec[i] = 0;
  if (i < 2) {
    positionActive[i] = false; positionPid[i].reset();
    positionBreakaway[i] = {};
  }
  if (i == 1 && tiltSweep.status == TiltSweepStatus::Running) {
    tiltSweep.status = TiltSweepStatus::Cancelled; tiltMaxSpeedDegPerSec = savedSweepSpeedLimit;
  }
  if (i == 1) mcpwm_set_signal_low(MCPWM_UNIT_0, MCPWM_TIMER_0, MCPWM_OPR_A);
  else ledc_stop(LEDC_LOW_SPEED_MODE, ledc_channel_t(i), 0);
  portENTER_CRITICAL(&servoMux);
  enabled[i] = false;
  targetPulseUs[i] = pulseUs[i]; rampPulseUs[i] = pulseUs[i];
  portEXIT_CRITICAL(&servoMux);
  if (i < 2) { trajectoryVelocity[i] = 0; trackingFaultStartedUs[i] = 0; overspeedConfirmation[i].reset(); speedControl[i].reset(); continuousDemandSpeed[i] = 0; }
}
void acknowledge(int i) {
  ControlMessage message = {};
  snprintf(message.text, sizeof(message.text), "Servo ack: %s PULSE=%lu FREQ=%lu ENABLE=%d TARGET=%lu", SERVO_CONFIG[i].name,
    (unsigned long)pulseUs[i], (unsigned long)frequencyHz[i], enabled[i], (unsigned long)targetPulseUs[i]);
  queueControlMessage(message.text);
}
void safetyState() {
  ControlMessage message = {};
  snprintf(message.text, sizeof(message.text), "Servo safety: ARMED=%d ESTOP=%d", armed, estopLatched);
  queueControlMessage(message.text);
}
bool safetyCommand(const char *line) {
  if (strcmp(line, "ESTOP") && strncmp(line, "SERVOS ", 7)) return false;
  const char *action = !strcmp(line, "ESTOP") ? "ESTOP" : line + 7;
  if (!strcmp(action, "ESTOP") || !strcmp(action, "DISABLE")) {
    portENTER_CRITICAL(&servoMux);
    armed = false;
    if (!strcmp(action, "ESTOP")) estopLatched = true;
    portEXIT_CRITICAL(&servoMux);
    for (int i = 0; i < 3; ++i) if (ready[i]) stopOutput(i);
  } else if (!strcmp(action, "ENABLE")) {
    if (estopLatched) { queueControlMessage("Servo error: E-stop latched; clear it before enabling"); return true; }
    portENTER_CRITICAL(&servoMux); armed = true; portEXIT_CRITICAL(&servoMux);
  } else if (!strcmp(action, "CLEAR")) {
    // Clearing never restores PWM or arms the outputs.
    for (int i = 0; i < 3; ++i) if (ready[i]) stopOutput(i);
    portENTER_CRITICAL(&servoMux); armed = false; estopLatched = false; portEXIT_CRITICAL(&servoMux);
  } else { queueControlMessage("Servo error: expected SERVOS ENABLE, DISABLE, ESTOP, or CLEAR"); return true; }
  safetyState(); return true;
}

}  // namespace servo_internal

using namespace servo_internal;

void initServoOutputs() {
  loadPanSettings(); // Configuration only: never restore output/arming state.
  loadTrackHome();
  for (int i = 0; i < 3; ++i) {
    const auto &c = SERVO_CONFIG[i];
    if (!validConfig(c)) { Serial.println("Servo error: invalid configuration"); continue; }
    if (i == 1) {
      mcpwm_config_t config = {};
      config.frequency = c.centerFrequencyHz; config.counter_mode = MCPWM_UP_COUNTER;
      config.duty_mode = MCPWM_DUTY_MODE_0;
      ready[i] = mcpwm_group_set_resolution(MCPWM_UNIT_0, 32000000) == ESP_OK &&
        mcpwm_timer_set_resolution(MCPWM_UNIT_0, MCPWM_TIMER_0, 3200000) == ESP_OK &&
        mcpwm_gpio_init(MCPWM_UNIT_0, MCPWM0A, c.gpio) == ESP_OK &&
        mcpwm_init(MCPWM_UNIT_0, MCPWM_TIMER_0, &config) == ESP_OK;
      pulseUs[i] = neutralPulse(i); frequencyHz[i] = c.centerFrequencyHz;
      targetPulseUs[i] = pulseUs[i]; rampPulseUs[i] = pulseUs[i];
      if (ready[i]) stopOutput(i);
      continue;
    }
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_LOW_SPEED_MODE; timer.duty_resolution = LEDC_TIMER_14_BIT;
    timer.timer_num = ledc_timer_t(i); timer.freq_hz = c.centerFrequencyHz; timer.clk_cfg = LEDC_USE_APB_CLK;
    if (ledc_timer_config(&timer) != ESP_OK) continue;
    ledc_channel_config_t channel = {};
    channel.gpio_num = c.gpio; channel.speed_mode = LEDC_LOW_SPEED_MODE;
    channel.channel = ledc_channel_t(i); channel.timer_sel = ledc_timer_t(i);
    channel.intr_type = LEDC_INTR_DISABLE; channel.duty = 0;
    ready[i] = ledc_channel_config(&channel) == ESP_OK;
    pulseUs[i] = continuous(i) ? neutralPulse(i) : c.centerPulseUs; frequencyHz[i] = c.centerFrequencyHz;
    targetPulseUs[i] = pulseUs[i]; rampPulseUs[i] = pulseUs[i];
    if (ready[i]) stopOutput(i);
  }
}

void readServoCommands(bool reset) {
  static char buffer[120]; static size_t used = 0; static bool overflow = false;
  if (reset) { used = 0; overflow = false; cancelServoMotion(); return; }
  for (int budget = 0; budget < 128 && telemetryStream().available(); ++budget) {
    const char ch = telemetryStream().read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      buffer[used] = '\0';
      if (overflow) queueControlMessage("Servo error: command too long");
      else if (used) {
        const uint64_t started = esp_timer_get_time();
        if (!handleAdcCommand(buffer) && !handleSensorCommand(buffer)) command(buffer);
        ++controlHealth.commands;
        const unsigned elapsed = esp_timer_get_time() - started;
        if (elapsed > controlHealth.maxCommandUs) controlHealth.maxCommandUs = elapsed;
      }
      used = 0; overflow = false;
    } else if (used < sizeof(buffer) - 1 && !overflow) buffer[used++] = ch;
    else overflow = true;
  }
}

void queueControlMessage(const char *text) {
  if (!messages) return;
  ControlMessage message = {};
  strlcpy(message.text, text, sizeof(message.text));
  xQueueSend(messages, &message, 0);
}

bool startControlReceiver() {
  messages = xQueueCreate(32, sizeof(ControlMessage));
  if (!messages) return false;
  return true; // TCP socket commands are read by the sole writer task.
}

bool printControlMessages() {
  ControlMessage message;
  bool any = false;
  while (messages && xQueueReceive(messages, &message, 0) == pdPASS) {
    telemetryStream().println(message.text); any = true;
  }
  return any;
}


ServoControlHealth servoControlHealth() { return controlHealth; }
