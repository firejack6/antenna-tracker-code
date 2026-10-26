#include "servo_internal.h"
#include "network_transport.h"
#include "servo_feedback.h"
#include "tilt_imu.h"
#include "tilt_calibration.h"
#include "servo_motion_config.h"
#include "servo_motion_math.h"
#include "continuous_speed_control.h"
#include <esp_timer.h>
#include <driver/ledc.h>
#include <driver/mcpwm.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

using namespace servo_internal;

void cancelServoMotion() {
  for (int i = 0; i < 3; ++i) {
    // A held pulse keeps a continuous servo MOVING. Remove PWM on link loss.
    if ((continuous(i) || (i < 2 && positionActive[i]) || manualDirect[i]) && enabled[i]) stopOutput(i);
    targetPulseUs[i] = pulseUs[i]; rampPulseUs[i] = pulseUs[i];
  }
  lastMotionUs = esp_timer_get_time();
  for (int i = 0; i < 2; ++i) { trajectoryVelocity[i] = 0; trackingFaultStartedUs[i] = 0; }
}

void updateServoMotion() {
  const uint64_t now = esp_timer_get_time();
  if (lastMotionUs && now - lastMotionUs < servoMotionIntervalUs) return;
  const float dt = lastMotionUs ? fminf((now - lastMotionUs) * 1e-6f, 0.02f) : 0;
  lastMotionUs = now;
  auto fb = latestServoFeedback();
  float tiltVelocityAngle = NAN;
  // Use the same robust voltage for velocity, limits and sweep extrema/wraps.
  // ADC logging and the VOLTS telemetry field retain the unfiltered samples.
  if (fb.deviceUs && now >= fb.deviceUs && now - fb.deviceUs <= servoFeedbackTimeoutUs) {
    // The pot is powered from 3.3 V. Reject impossible rail excursions before
    // they enter either filter or falsely arm rollover detection. Raw logging
    // retains these samples; sustained invalid input still stops the output.
    if (isfinite(fb.tiltVolts) && fb.tiltVolts >= 0 && fb.tiltVolts <= servoFeedbackMaxVolts+tiltFeedbackEndpointToleranceVolts) {
      tiltVelocityPotFilter.update(fb.tiltVolts, fb.deviceUs, servoFeedbackTimeoutUs);
      tiltPotFilter.update(fb.tiltVolts, fb.deviceUs, servoFeedbackTimeoutUs);
      lastValidTiltPotUs = fb.deviceUs;
    }
    tiltVelocityAngle = tiltAngleFromVolts(tiltVelocityPotFilter.value, getTiltCalibration());
    fb.tiltVolts = tiltPotFilter.value;
    fb.tiltDegrees = tiltAngleFromVolts(fb.tiltVolts, getTiltCalibration());
  }
  if (tiltSweep.status == TiltSweepStatus::Running) {
    const bool rawFresh = fb.deviceUs && now >= fb.deviceUs && now - fb.deviceUs <= servoFeedbackTimeoutUs && lastValidTiltPotUs && now-lastValidTiltPotUs <= servoFeedbackTimeoutUs;
    // wrappedAngleDelta handles the pot wrap. Resetting on every >0.25 V
    // change hid genuine fast movement from the speed controller.
    if (!rawFresh) { tiltSweep.status = TiltSweepStatus::Fault; tiltSweep.fault = TiltSweepFault::StaleFeedback; }
    const auto status = rawFresh ? tiltSweep.observe(fb.tiltVolts, now) : tiltSweep.status;
    if (status != TiltSweepStatus::Running) {
      tiltMaxSpeedDegPerSec = savedSweepSpeedLimit; stopOutput(1);
      queueControlMessage(status == TiltSweepStatus::Complete ? "Tilt sweep complete; output stopped; range ready to apply" : "Servo error: TILT sweep stopped; feedback, stall, or timeout fault");
    } else {
      const auto calibration = getTiltCalibration();
      fb.tiltDegrees = (fb.tiltVolts - calibration.minVolts) * 360 / (calibration.maxVolts - calibration.minVolts) - calibration.zeroDeg;
    }
  }
  for (int i = 0; i < 3; ++i) {
    if (!pwmSweep[i].active || !enabled[i] || !armed || estopLatched) continue;
    const float direction = pwmSweep[i].endUs >= pwmSweep[i].startUs ? 1.f : -1.f;
    float next = pwmSweep[i].currentUs + direction * pwmSweep[i].rateUsPerSec * dt;
    const bool done = direction > 0 ? next >= pwmSweep[i].endUs : next <= pwmSweep[i].endUs;
    if (done) next = pwmSweep[i].endUs;
    if (!applyPulse(i, next)) {
      stopOutput(i);
      queueControlMessage("Servo error: pwm sweep PWM update failed");
      continue;
    }
    pwmSweep[i].currentUs = next;
    rampPulseUs[i] = next;
    targetPulseUs[i] = uint32_t(lroundf(next));
    if (done) {
      pwmSweep[i].active = false;
      ControlMessage message = {};
      snprintf(message.text, sizeof(message.text), "Servo pwm sweep: %s COMPLETE", SERVO_CONFIG[i].name);
      queueControlMessage(message.text);
    }
  }
  for (int i = 0; i < 2; ++i) {
    bool fresh = feedbackFresh(fb, i, now) && (i != 1 || (lastValidTiltPotUs && now-lastValidTiltPotUs <= servoFeedbackTimeoutUs));
    if (i == 1 && tiltSweep.status == TiltSweepStatus::Running && tiltSweep.rolloverActive) {
      // The pot seam has no useful voltage-to-angle derivative. Keep the last
      // bounded PWM, freeze PI, and restart velocity estimation after the seam.
      if (!fresh) { stopOutput(i); queueControlMessage("Servo error: rollover feedback stale"); }
      measuredDegrees[i] = feedbackAngle(fb, i); measuredSpeed[i] = NAN; tiltVelocityWindow.reset();
      overspeedConfirmation[i].reset(); invalidVelocityStartedUs[i] = 0;
      lastFeedbackUs[i] = fb.deviceUs; previousFeedbackAngle[i] = tiltVelocityAngle;
      continue;
    }

    if (fresh && fb.deviceUs != lastFeedbackUs[i]) {
      const float angle = feedbackAngle(fb, i);
      const float velocityAngle = i == 1 ? tiltVelocityAngle : angle;
      const float elapsed = lastFeedbackUs[i] ? (fb.deviceUs - lastFeedbackUs[i]) * 1e-6f : 0;
      if (elapsed > 0 && elapsed < 0.1f && isfinite(filteredDegrees[i]) && isfinite(measuredSpeed[i]) && isfinite(previousFeedbackAngle[i])) {
        const float period = i == 0 ? fabsf(panCalibration.span) : 360.0f;
        const float delta = continuous(i) ? wrappedAngleDelta(velocityAngle*360/period, previousFeedbackAngle[i]*360/period)*period/360 : velocityAngle - previousFeedbackAngle[i];
        const float alpha = elapsed / ((i == 1 ? 0.02f : 0.10f) + elapsed);
        measuredSpeed[i] += alpha * (delta / elapsed - measuredSpeed[i]);
        filteredDegrees[i] += elapsed / (0.05f + elapsed) * (angle - filteredDegrees[i]);
      } else { filteredDegrees[i] = angle; measuredSpeed[i] = 0; }
      if (i == 1) measuredSpeed[i] = tiltVelocityWindow.update(velocityAngle, fb.deviceUs);
      measuredDegrees[i] = angle; lastFeedbackUs[i] = fb.deviceUs;
      previousFeedbackAngle[i] = velocityAngle;
    } else if (!fresh) { measuredDegrees[i] = NAN; measuredSpeed[i] = NAN; }
    if (usesImu(i)) {
      const auto imu = latestTiltImu(); fresh = imuFresh(imu,now);
      measuredDegrees[i] = fresh ? imu.angle[tiltImuAxis]-tiltImuZero : NAN;
      measuredSpeed[i] = fresh ? imu.speed[tiltImuAxis] : NAN;
    }
    if (!enabled[i] || !armed || estopLatched) continue;
    // Absolute PWM sweep owns the pulse; closed-loop must not overwrite it.
    if (pwmSweep[i].active) continue;
    // Manual RAW: trapezoid PWM toward target (rate/accel 0 => snap).
    if (manualDirect[i]) {
      const auto &c = SERVO_CONFIG[i];
      const float next = smoothServoPulse(rampPulseUs[i], float(targetPulseUs[i]), pwmSlewVelocityUsPerSec[i],
        pwmSlewMaxRateUsPerSec[i], pwmSlewAccelUsPerSec2[i], dt);
      rampPulseUs[i] = fminf(c.maxPulseUs, fmaxf(c.minPulseUs, next));
      if ((i == 1 ? fabsf(rampPulseUs[i] - actualTiltPulseUs) >= .15625f : uint32_t(lroundf(rampPulseUs[i])) != pulseUs[i]) &&
          !applyPulse(i, i == 1 ? rampPulseUs[i] : float(uint32_t(lroundf(rampPulseUs[i]))))) {
        stopOutput(i); queueControlMessage("Servo error: PWM slew update failed");
      }
      continue;
    }
    if (!isfinite(speedLimit(i)) || speedLimit(i) < 0 || speedLimit(i) > 360) {
      stopOutput(i); queueControlMessage("Servo error: invalid speed limit"); continue;
    }
    if (positionActive[i]) {
      if (!fresh || !isfinite(measuredSpeed[i])) {
        stopOutput(i); queueControlMessage("Servo error: position feedback unavailable"); continue;
      }
      const auto calibration = getTiltCalibration();
      const float lower = positionLowerAngle(i);
      const float upper = positionUpperAngle(i);
      if (positionTarget[i] < lower || positionTarget[i] > upper) {
        stopOutput(i); queueControlMessage("Servo error: position target outside limits"); continue;
      }
      const float step = (i == 0 ? panPositionRampDegPerSec : tiltPositionRampDegPerSec)*dt;
      if (i == 0 ? panPositionRampEnabled : tiltPositionRampEnabled)
        positionSetpoint[i] += fminf(step, fmaxf(-step, positionTarget[i]-positionSetpoint[i]));
      else positionSetpoint[i] = positionTarget[i];
      if (!continuous(i)) {
        // Angular PWM supplies feedforward; TILT adds an IMU position correction.
        if (!usesImu(i)) { positionPid[i].reset(); positionPid[i].error = positionTarget[i] - measuredDegrees[i]; }
        const auto &c = SERVO_CONFIG[i];
        const float base = angularPositionPulse(i, positionSetpoint[i]);
        float correction = 0;
        if (usesImu(i)) {
          if (!tiltImuMappingReady) { stopOutput(i); queueControlMessage("Servo error: IMU mapping not calibrated"); continue; }
          correction = positionPid[i].update(positionSetpoint[i],measuredDegrees[i],measuredSpeed[i],dt,tiltPositionPidConfig,0,0,true);
          correction *= tiltImuMaxPulseAngle > tiltImuMinPulseAngle ? 1 : -1;
        }
        if (!isfinite(base) || !isfinite(correction)) { stopOutput(i); queueControlMessage("Servo error: invalid IMU correction"); continue; }
        const float output = fminf(usesImu(i) ? tiltImuMappedMaxPulse : c.maxPulseUs,fmaxf(usesImu(i) ? tiltImuMappedMinPulse : c.minPulseUs,base+correction));
        if (usesImu(i) && output != base+correction) positionPid[i].integral = 0;
        if (!isfinite(output) || output < c.minPulseUs || output > c.maxPulseUs) {
          stopOutput(i); queueControlMessage("Servo error: angular PWM mapping outside limits"); continue;
        }
        rampPulseUs[i] = output;
        if ((i == 1 ? fabsf(output-actualTiltPulseUs) >= .15625f : uint32_t(lroundf(output)) != pulseUs[i]) && !applyPulse(i, output)) {
          stopOutput(i); queueControlMessage("Servo error: angular position PWM update failed");
        }
        continue;
      }
      const auto &config = i == 0 ? panPositionPidConfig : tiltPositionPidConfig;
      const bool positive = continuousDirection(i) > 0;
      const float plus = i == 0 ? panPositiveDeadbandUs : tiltPositiveDeadbandUs;
      const float minus = i == 0 ? panNegativeDeadbandUs : tiltNegativeDeadbandUs;
      float offset = positionPid[i].update(positionSetpoint[i], measuredDegrees[i], measuredSpeed[i], dt, config,
        positive ? plus : minus, positive ? minus : plus);
      if (!isfinite(offset)) { stopOutput(i); continue; }
      // Limits use the feedback's angle direction, before PWM polarity.
      if ((measuredDegrees[i] <= lower && offset < 0) || (measuredDegrees[i] >= upper && offset > 0)) offset = 0;
      const bool excessive = speedLimit(i) > 0 && (i == 0 ? panOverspeedFaultEnabled : tiltOverspeedFaultEnabled) && fabsf(measuredSpeed[i]) > speedLimit(i)*1.5f+5;
      if (overspeedConfirmation[i].update(excessive, fb.deviceUs, now, continuousFaultMinimumReadings, continuousFaultDelayUs)) {
        stopOutput(i); queueControlMessage("Servo error: position overspeed"); continue;
      }
      const auto &c = SERVO_CONFIG[i];
      const float output = fminf(c.maxPulseUs, fmaxf(c.minPulseUs, neutralPulse(i)+continuousDirection(i)*offset));
      rampPulseUs[i] = output;
      if ((i == 1 ? fabsf(output-actualTiltPulseUs) >= .15625f : uint32_t(lroundf(output)) != pulseUs[i]) && !applyPulse(i, output)) {
        stopOutput(i); queueControlMessage("Servo error: position PWM update failed");
      }
      continue;
    }
    if (continuous(i)) {
      if ((speedLimit(i) > 0 || i == 1) && !fresh) {
        stopOutput(i); queueControlMessage("Servo error: continuous output stopped; feedback stale"); continue;
      }
      if (speedLimit(i) > 0 && !isfinite(measuredSpeed[i])) {
        overspeedConfirmation[i].reset();
        if (!invalidVelocityStartedUs[i]) invalidVelocityStartedUs[i] = now;
        if (now-invalidVelocityStartedUs[i] >= servoFeedbackTimeoutUs) {
          stopOutput(i); queueControlMessage("Servo error: invalid velocity feedback persisted");
        }
        continue; // Brief invalid sample: retain actual PWM and controller state.
      }
      invalidVelocityStartedUs[i] = 0;
      const auto &c = SERVO_CONFIG[i];
      const float demand = speedLimit(i) > 0 ? continuousRequestedSpeed(targetPulseUs[i], neutralPulse(i), c.minPulseUs, c.maxPulseUs, speedLimit(i), continuousNeutralDeadbandUs) : 0;
      if (i == 1 && tiltSweep.status != TiltSweepStatus::Running) {
        const float direction = speedLimit(i) > 0 ? demand : float(int(targetPulseUs[i]) - int(neutralPulse(i))) * continuousDirection(i);
        if (tiltMovingOutOfLimits(fb.tiltDegrees, direction, getTiltCalibration())) {
          stopOutput(i); queueControlMessage("Tilt angle limit reached; output stopped"); continue;
        }
      }
      continuousDemandSpeed[i] = demand;
      float output = neutralPulse(i);
      if (speedLimit(i) == 0) {
        // Unregulated CR: trapezoid PWM toward target (host used to microstep this).
        output = smoothServoPulse(rampPulseUs[i], float(targetPulseUs[i]), pwmSlewVelocityUsPerSec[i],
          pwmSlewMaxRateUsPerSec[i], pwmSlewAccelUsPerSec2[i], dt);
      } else if (demand != 0) {
        trajectoryVelocity[i] = accelerateVelocity(trajectoryVelocity[i], demand, servoMaxAccelerationDegPerSec2, dt);
        const bool sweeping = i == 1 && tiltSweep.status == TiltSweepStatus::Running;
        // Express feedback in the commanded sweep direction; backward slip
        // must not be mistaken for forward overspeed.
        const float maxOffset = i == 1 ? (tiltSweep.status == TiltSweepStatus::Running ? tiltSweep.pulseOffsetCapUs : tiltContinuousMaxPulseOffsetUs) : continuousMaxPulseOffsetUs;
        const int physicalSign = (demand > 0 ? 1 : -1) * continuousDirection(i);
        const float deadband = i == 0 ? (physicalSign > 0 ? panPositiveDeadbandUs : panNegativeDeadbandUs) :
          (sweeping ? tiltSweep.minimumOffsetUs : (physicalSign > 0 ? tiltPositiveDeadbandUs : tiltNegativeDeadbandUs));
        const float offset = speedControl[i].update(trajectoryVelocity[i],
          sweeping ? sweepMeasuredVelocity(measuredSpeed[i], tiltSweep.direction, demand) : measuredSpeed[i],
          (rampPulseUs[i] - neutralPulse(i)) * continuousDirection(i), deadband,
          continuousFeedforward(i), i == 1 ? tiltVelocityKp : continuousVelocityKp,
          i == 1 ? tiltVelocityKi : continuousVelocityKi, i == 1 ? tiltIntegralLimitUs : continuousIntegralLimitUs,
          maxOffset, dt, i == 1 ? tiltPwmRiseUsPerSec : panPwmRiseUsPerSec,
          i == 1 ? tiltPwmFallUsPerSec : panPwmFallUsPerSec,
          i == 1 ? tiltStartupSearchUsPerSec : panStartupSearchUsPerSec,
          i == 1 ? tiltStartupSearchMaxUs : panStartupSearchMaxUs, continuousMovingThresholdDegPerSec,
          i == 1 ? tiltPwmRecoveryRiseUsPerSec : 0, i == 1,
          i == 1 ? tiltBrakingConfirmSeconds : panBrakingConfirmSeconds);
        output += continuousDirection(i) * offset;
      } else { trajectoryVelocity[i] = 0; speedControl[i].reset(); }
      const bool fault = (i == 0 ? panOverspeedFaultEnabled : tiltOverspeedFaultEnabled) && speedLimit(i) > 0 && fabsf(measuredSpeed[i]) > speedLimit(i) * 1.5f + 5;
      if (overspeedConfirmation[i].update(fault, fb.deviceUs, now, continuousFaultMinimumReadings, continuousFaultDelayUs)) {
          if (i == 1 && tiltSweep.status == TiltSweepStatus::Running) {
            tiltSweep.status = TiltSweepStatus::Fault;
            tiltSweep.fault = fabsf(measuredSpeed[i]) > speedLimit(i) * 1.5f + 5 ? TiltSweepFault::Overspeed : TiltSweepFault::WrongDirection;
            tiltMaxSpeedDegPerSec = savedSweepSpeedLimit;
          }
          stopOutput(i); queueControlMessage("Servo error: continuous output stopped; overspeed or wrong direction"); continue;
      }
      rampPulseUs[i] = fminf(c.maxPulseUs, fmaxf(c.minPulseUs, output));
      const uint32_t pulse = uint32_t(lroundf(rampPulseUs[i]));
      if ((i == 1 ? fabsf(rampPulseUs[i] - actualTiltPulseUs) >= .15625f : pulse != pulseUs[i]) && !applyPulse(i, i == 1 ? rampPulseUs[i] : float(pulse))) {
        if (i == 1 && tiltSweep.status == TiltSweepStatus::Running) {
          tiltSweep.status = TiltSweepStatus::Fault; tiltSweep.fault = TiltSweepFault::PwmUpdate;
          tiltMaxSpeedDegPerSec = savedSweepSpeedLimit;
        }
        stopOutput(i); queueControlMessage("Servo error: continuous PWM update failed");
      }
      continue;
    }
    if (speedLimit(i) == 0) continue;
    if (!fresh || !isfinite(speedLimit(i)) || speedLimit(i) < 0) {
      stopOutput(i); queueControlMessage("Servo error: speed-limited output stopped; feedback stale or invalid limit"); continue;
    }
    const auto &c = SERVO_CONFIG[i];
    const float current = pulseToDeviceAngle(rampPulseUs[i], c.minPulseUs, c.maxPulseUs, minAngle(i), maxAngle(i));
    const float target = pulseToDeviceAngle(targetPulseUs[i], c.minPulseUs, c.maxPulseUs, minAngle(i), maxAngle(i));
    if (fabsf(current - filteredDegrees[i]) > servoFeedbackMaxTrackingErrorDeg) {
      if (!trackingFaultStartedUs[i]) trackingFaultStartedUs[i] = now;
      if (now - trackingFaultStartedUs[i] >= servoFeedbackTrackingFaultUs) {
        stopOutput(i); queueControlMessage("Servo error: output stopped; sustained feedback tracking error"); continue;
      }
    } else trackingFaultStartedUs[i] = 0;
    const float next = smoothServoAngle(current, target, trajectoryVelocity[i], speedLimit(i), servoMaxAccelerationDegPerSec2, dt);
    rampPulseUs[i] = deviceAngleToPulse(next, c.minPulseUs, c.maxPulseUs, minAngle(i), maxAngle(i));
    const uint32_t pulse = uint32_t(lroundf(fminf(c.maxPulseUs, fmaxf(c.minPulseUs, rampPulseUs[i]))));
    if (pulse != pulseUs[i] && !applyPulse(i, pulse)) {
      stopOutput(i); queueControlMessage("Servo error: PWM ramp update failed");
    }
  }
  const unsigned elapsed = esp_timer_get_time() - now;
  if (elapsed > controlHealth.maxUpdateUs) controlHealth.maxUpdateUs = elapsed;
}

namespace {
void servoMotionTask(void *) {
  TickType_t wake = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS((servoMotionIntervalUs + 999) / 1000);
  for (;;) {
    updateServoMotion();
    vTaskDelayUntil(&wake, period ? period : 1);
  }
}
}

bool startServoMotionTask() {
  // Priority 4: above TCP writer (3) and I2C (2) so Wi-Fi backpressure cannot stretch the loop.
  return xTaskCreatePinnedToCore(servoMotionTask, "servo-motion", 6144, nullptr, 4, nullptr, 0) == pdPASS;
}
