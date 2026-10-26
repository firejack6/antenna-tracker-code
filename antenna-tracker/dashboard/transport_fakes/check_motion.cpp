#include "../../src/servo_feedback.h"
#include "../../src/servo_motion_math.h"
#include "../../src/continuous_speed_control.h"
#include "../../src/servo_feedback_filter.h"
#include <cassert>
#include "../../src/tilt_imu.h"
#include "../../src/pan_calibration.h"
int main() {
  PanCalibration pan;
  assert(validPanCalibration(pan));
  assert(fabsf(panAngleFromVolts(.004f,pan)) < .001f);
  assert(fabsf(panAngleFromVolts(3.3f,pan)-360) < .001f);
  pan.zero = 180;
  assert(fabsf(panAngleFromVolts(1.652f,pan)) < .001f);
  pan.span = -360;
  assert(fabsf(panAngleFromVolts(3.3f,pan)+540) < .001f);
  assert(!isfinite(panAngleFromVolts(NAN,pan)));
  assert(!isfinite(panAngleFromVolts(5,pan)));
  pan.polarity = 0; assert(!validPanCalibration(pan));
  pan = PanCalibration{}; pan.vmax = pan.vmin; assert(!validPanCalibration(pan));
  TiltImuFilter imu;
  for (int n=0; n<=110; ++n) {
    const float angle = 80+n, radians = angle*3.14159265f/180;
    imu.update(-sinf(radians),0,cosf(radians),0,100,1000+10000*n);
    assert(fabsf(imu.sample.angle[1]-angle)<.05f);
  }
  assert(imu.sample.angle[1]>180); // Neither 90-degree folding nor 180-degree jump.
  const auto stamp = imu.sample.deviceUs;
  imu.update(NAN,0,1,0,0,stamp+10000);
  assert(imu.sample.deviceUs == stamp); // Invalid sensor data cannot refresh feedback.
  imu.update(0,0,2,0,0,stamp+300000);
  assert(!isfinite(imu.sample.angle[1])); // No valid gravity for 250 ms stops feedback.

  assert(deviceAngleToPulse(0, 500, 2500, 0, 110) == 500);
  assert(deviceAngleToPulse(55, 500, 2500, 0, 110) == 1500);
  assert(deviceAngleToPulse(110, 500, 2500, 0, 110) == 2500);
  // Angular position commands map to pulse endpoints, rather than neutral + PID.
  assert(deviceAngleToPulse(0, 500, 2500, 0, 360) == 500);
  assert(deviceAngleToPulse(180, 500, 2500, 0, 360) == 1500);
  assert(deviceAngleToPulse(360, 500, 2500, 0, 360) == 2500);
  assert(deviceAngleToPulse(90, 500, 2500, 360, 0) == 2000);

  PositionPid position;
  PositionPidConfig gains = {1, 1, .5f, 5, 60, 1};
  assert(validPositionPid(gains));
  assert(position.update(10, 0, 0, .02f, gains, 42, 60) > 52);
  assert(position.update(-10, 0, 0, .02f, gains, 42, 60) == -60);
  position.reset();
  for (int n=0; n<1000; ++n) position.update(100, 0, 0, .02f, gains, 42, 60);
  assert(position.integral == 0); // Saturation cannot wind up integral.
  assert(position.update(10, 9.5f, 0, .02f, gains, 42, 60) == 0);
  assert(position.integral == 0); // Neutral and clear integral inside tolerance.
  position.integral = 3;
  assert(position.update(10, 9.5f, 0, .02f, gains, 0, 0, true) == 3);
  assert(position.integral == 3); // IMU hold retains the learned PWM trim.
  assert(position.update(10, 10, 2, .02f, gains, 0, 0, true) == 2);
  position.reset();
  position.update(10, 0, 8, .02f, gains, 42, 60);
  assert(position.d == -4); // Derivative opposes measured velocity.
  position.update(20, 0, 8, .02f, gains, 42, 60);
  assert(position.d == -4); // New target produces no derivative kick.
  assert(isnan(position.update(0, NAN, 0, .02f, gains, 42, 60)));
  gains.kp = NAN; assert(!validPositionPid(gains));
  assert(sweepMeasuredVelocity(-20, 1, 5) == -20); // Backward slip must increase forward correction.
  assert(sweepMeasuredVelocity(-20, -1, 5) == 20);
  assert(sweepMeasuredVelocity(-20, -1, -5) == -20);
  ConsecutiveFeedbackFault fault;
  for (unsigned n = 1; n < 6; ++n)
    assert(!fault.update(true, n, n*100000, 6, 500000));
  assert(!fault.update(true, 5, 1000000, 6, 500000)); // Repeated frame is not a reading.
  assert(fault.update(true, 6, 1100000, 6, 500000));
  assert(!fault.update(false, 7, 1200000, 6, 500000));
  assert(!fault.update(true, 8, 1300000, 6, 500000)); // An in-range reading resets streak.
  ContinuousSpeedControl staged;
  float stagedOutput = 48;
  auto stagedStep = [&](float measured) {
    stagedOutput = staged.update(5, measured, stagedOutput, 48, .03f, .08f, .02f,
      4, 55, .005f, 2, 200, .5f, 8, .5f, 10, true);
  };
  for (int n = 0; n < 100; ++n) stagedStep(0);
  assert(staged.phase == SpeedControlPhase::Starting && staged.integral == 0 && staged.pTerm == 0);
  stagedStep(30); stagedStep(0); // A lone spike cannot enter running mode.
  assert(staged.phase == SpeedControlPhase::Starting);
  for (int n = 0; n < 30; ++n) stagedStep(5);
  assert(staged.phase == SpeedControlPhase::Running);
  for (int n = 0; n < 100; ++n) stagedStep(0);
  assert(staged.phase == SpeedControlPhase::Running); // Brief pauses retain running state.
  for (int n = 0; n < 100; ++n) stagedStep(0);
  assert(staged.phase == SpeedControlPhase::Recovering);
  stagedOutput = 40;
  const float beforeRecovery = stagedOutput;
  stagedStep(0);
  assert(stagedOutput > beforeRecovery + .049f); // Confirmed stall uses 10 us/s, not startup's 2 us/s.
  for (int n = 0; n < 30; ++n) stagedStep(5);
  assert(staged.phase == SpeedControlPhase::Running);
  staged.reset(); assert(staged.phase == SpeedControlPhase::Stopped);
  stagedOutput = 48;
  stagedStep(0);
  const float validOutput = stagedOutput, validSearch = staged.startupExtra;
  stagedStep(NAN);
  assert(stagedOutput == validOutput && staged.startupExtra == validSearch);
  assert(staged.phase == SpeedControlPhase::Starting); // Invalid speed cannot reduce startup drive.
  ServoVelocityWindow velocityWindow;
  float estimated = 0;
  for (int n = 0; n < 100; ++n)
    estimated = velocityWindow.update(fmodf(359 + n*.025f, 360), 1000000+n*5000);
  assert(fabsf(estimated-5) < .02f); // Constant 5 deg/s survives pot wrap.
  velocityWindow.reset();
  for (int n = 0; n < 100; ++n)
    estimated = velocityWindow.update(100 + (n%2 ? .03f : -.03f), 1000000+n*5000);
  assert(fabsf(estimated) < .05f); // ADC dither must not trigger breakaway.
  assert(velocityWindow.update(100, 3000000) == 0); // Stale interval resets history.
  ContinuousSpeedControl retainedDrive;
  retainedDrive.direction = 1; retainedDrive.startupExtra = 4;
  retainedDrive.update(5, 30, 46, 42, .03f, .01f, .005f, 2, 48,
    .005f, 2, 200, .5f, 8, .5f, 10);
  assert(retainedDrive.startupExtra > 3.99f); // A brief spike cannot erase breakaway drive.
  ContinuousSpeedControl control;
  float pwmOffset = 0;
  auto step = [&](float target, float measured, float cap = 600) {
    const float previous = pwmOffset;
    pwmOffset = control.update(target, measured, pwmOffset, 45, 3, .5f, .5f,
      100, cap, .02f, 10, 80, 1, 10, .5f);
    if (target != 0) assert(fabsf(pwmOffset - previous) <= 1.6001f);
  };
  // A minute at rest must not wind up toward the large sweep cap.
  for (int n = 0; n < 3000; ++n) step(3, 0);
  assert(control.integral == 0 && pwmOffset <= 65.51f);
  assert(control.startupExtra <= 10);
  assert(fabsf(control.pTerm - 1.5f) < .0001f);
  assert(control.iTerm == 0 && control.feedforwardTerm == 54);
  assert(fabsf(control.requestedOffset - (control.pTerm + control.iTerm + control.feedforwardTerm + control.startupTerm)) < .0001f);
  const float breakawayOffset = pwmOffset;
  // Once moving above target, shed startup drive and reduce output immediately.
  step(3, 12);
  assert(pwmOffset < breakawayOffset && control.integral <= 0);
  control.reset(); pwmOffset = 0;
  for (int n = 0; n < 1000; ++n) step(3, 1, 30);
  assert(pwmOffset <= 30.001f && control.integral == 0);
  // Reversal discards stored drive and approaches neutral first.
  control.integral = 20; pwmOffset = 55;
  step(-3, 0); assert(pwmOffset > 0 && control.integral == 0);
  step(0, 0); assert(pwmOffset == 0 && control.startupExtra == 0);
  // The measured 360-us deadband must be reachable without static PI windup.
  control.reset(); pwmOffset = 0;
  for (int n = 0; n < 3000; ++n) {
    const float previous = pwmOffset;
    pwmOffset = control.update(3, 0, pwmOffset, 360, 3, .5f, .5f,
      100, 500, .02f, 10, 80, 1, 10, .5f);
    assert(pwmOffset - previous <= .2001f);
  }
  assert(pwmOffset > 360 && pwmOffset <= 380.51f && control.integral == 0);
  // TILT retune: bounded startup near the observed 60–70 us threshold,
  // then shed output promptly on the several-hundred deg/s recorded burst.
  control.reset(); pwmOffset = 0;
  for (int n = 0; n < 3000; ++n) {
    const float previous = pwmOffset;
    pwmOffset = control.update(1, 0, pwmOffset, 60, .03f, .04f, .01f,
      8, 400, .02f, 2, 200, .5f, 8, .5f);
    assert(pwmOffset - previous <= .0401f);
  }
  assert(pwmOffset <= 68.08f && control.integral == 0);
  const float beforeBurst = pwmOffset;
  pwmOffset = control.update(1, 600, pwmOffset, 60, .03f, .04f, .01f,
    8, 400, .02f, 2, 200, .5f, 8, .5f);
  assert(pwmOffset <= beforeBurst - 3.99f && fabsf(control.integral) <= 8);
  // Live regression: movement begins below the configured deadband baseline.
  // Overspeed must reduce actual PWM, even while startup is still ramping.
  control.reset();
  float braking = control.update(1, 20, 48, 60, .03f, .15f, .04f,
    4, 70, .02f, 2, 200, .1f, 2, .5f);
  assert(braking < 48 && control.requestedOffset < 48);
  const float brakeTarget = control.requestedOffset;
  for (int n = 0; n < 10; ++n)
    braking = control.update(1, 20, braking, 60, .03f, .15f, 0,
      4, 70, .02f, 2, 200, .1f, 2, .5f);
  assert(braking > brakeTarget - .1f); // No repeated proportional subtraction.

  control.reset();
  control.direction = 1; control.integral = -1;
  control.update(5, 0, 40, 47, .03f, .06f, .02f, 4, 55, .02f, 2, 200, .1f, 2, .5f, 10);
  assert(control.integral == -1); // Braking calibration must survive a pause.
  control.update(5, 3, 40, 47, .03f, .06f, .02f, 4, 55, .02f, 2, 200, .1f, 2, .5f, 10);
  const float recovery = control.update(5, 0, 40, 47, .03f, .06f, .02f, 4, 55, .02f, 2, 200, .1f, 2, .5f, 10);
  assert(recovery > 40.19f && recovery < 40.21f);
  assert(control.integral > -1); // A pause unwinds learned braking after breakaway.
  for (int n = 0; n < 3000; ++n)
    control.update(5, 0, 47, 47, .03f, .06f, .02f, 4, 55, .02f, 2, 200, .1f, 2, .5f, 10);
  assert(control.integral <= 0 && control.integral > -.0001f); // No static windup.
  assert(feedbackDeviceDegrees(.004f, 1, 1) == 0);
  assert(fabsf(feedbackDeviceDegrees(3.3f, 5, 5) - 360) < .001f);
  assert(fabsf(feedbackDeviceDegrees(1.652f, 1, 1) - 180) < .001f);
  assert(isnan(feedbackDeviceDegrees(4, 1, 1)));
  assert(pulseToDeviceAngle(1500, 500, 2500, 360, 0) == 180);
  assert(deviceAngleToPulse(180, 500, 2500, 0, 360) == 1500);
  assert(fabsf(advanceServoAngle(10, 100, 10, .6f, 2) - 10.6f) < .001f);
  assert(advanceServoAngle(13, 100, 10, .6f, 2) == 13);
  assert(advanceServoAngle(13, 0, 10, .6f, 2) < 13);
  assert(advanceServoAngle(10, 10.1f, 10, .6f, 2) == 10.1f);
  float angle = 0, velocity = 0, previousVelocity = 0;
  for (int i = 0; i < 500; ++i) {
    const float next = smoothServoAngle(angle, 90, velocity, 30, 60, .02f);
    assert(next >= angle && next <= 90);
    assert(next - angle <= .6001f);
    assert(fabsf(velocity) <= 30);
    // Endpoint clamp may remove the final small residual velocity.
    if (next != 90) assert(fabsf(velocity - previousVelocity) <= 1.2001f);
    angle = next; previousVelocity = velocity;
  }
  assert(angle == 90 && velocity == 0);
  velocity = 30;
  angle = smoothServoAngle(90, 0, velocity, 30, 60, .02f);
  assert(angle > 90 && velocity > 0); // Reverse gradually, never snap direction.
  float slowVelocity = 0, slowAngle = 0;
  for (int i = 0; i < 100; ++i) slowAngle = smoothServoAngle(slowAngle, 5, slowVelocity, .5f, 60, .02f);
  assert(slowAngle > .9f && slowAngle < 1.01f); // Preserve sub-microsecond steps.
  assert(continuousRequestedSpeed(1500, 1500, 500, 2500, 30, 8) == 0);
  assert(continuousRequestedSpeed(1505, 1500, 500, 2500, 30, 8) == 0);
  assert(continuousRequestedSpeed(2500, 1500, 500, 2500, 30, 8) == 30);
  assert(continuousRequestedSpeed(500, 1500, 500, 2500, 30, 8) == -30);
  assert(wrappedAngleDelta(1, 359) == 2);
  assert(wrappedAngleDelta(359, 1) == -2);
  assert(fabsf(accelerateVelocity(0, 30, 60, .02f) - 1.2f) < .0001f);
}
