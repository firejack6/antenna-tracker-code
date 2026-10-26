#include "../../src/tilt_calibration.h"
#include "../../src/servo_feedback_filter.h"
#include <cassert>
#include <cmath>
#include <initializer_list>
#include <fstream>
#include <sstream>
#include <string>
#include <algorithm>
#include <iostream>
int main(int argc, char **argv) {
  assert(!tiltMovingOutOfLimits(0, -1, tiltCalibrationDefaults));
  assert(!tiltMovingOutOfLimits(360, 1, tiltCalibrationDefaults));
  TiltCalibration fullTurn; fullTurn.minAngleDeg = -180; fullTurn.maxAngleDeg = 180;
  assert(!tiltMovingOutOfLimits(-180, -1, fullTurn));
  assert(tiltAngleFromVolts(3.47f, tiltCalibrationDefaults) == 360);
  assert(isnan(tiltAngleFromVolts(3.6f, tiltCalibrationDefaults)));
  assert(tiltSweepStartingPulse(1500, 47.5f, 1, 1, 500, 2500) == 1547.5f);
  assert(tiltSweepStartingPulse(1500, 47.5f, -1, 1, 500, 2500) == 1452.5f);
  assert(tiltSweepStartingPulse(1500, 47.5f, 1, -1, 500, 2500) == 1452.5f);
  assert(tiltSweepStartingPulse(1500, 0, -1, -1, 500, 2500) == 1500);
  assert(tiltSweepStartingPulse(1500, 2000, 1, 1, 500, 2500) == 2500);

  ServoVelocityPotFilter fast;
  assert(fast.update(1, 1000, 100000) == 1);
  assert(fast.update(3, 21000, 100000) == 1); // Reject one isolated spike.
  assert(fast.update(1, 41000, 100000) == 1);
  assert(fast.update(1, 61000, 100000) == 1);
  assert(fast.update(2, 81000, 100000) == 1);
  assert(fast.update(2, 101000, 100000) == 2); // Real step passes in two updates.

  if (argc > 1) {
    std::ifstream csv(argv[1]); std::string line; std::getline(csv, line);
    ServoPotFilter replay;
    float previousRaw = NAN, previousFiltered = NAN, rawSpeed = 0, filteredSpeed = 0;
    float peakRaw = 0, peakFiltered = 0; uint64_t previousUs = 0;
    while (std::getline(csv, line)) {
      line.erase(std::remove(line.begin(), line.end(), '"'), line.end());
      std::stringstream row(line); std::string fields[6];
      for (auto &field : fields) std::getline(row, field, ',');
      if (fields[4].empty()) continue;
      const uint64_t us = uint64_t(std::stod(fields[0]) * 1000000);
      const float raw = std::stof(fields[4]);
      const float filtered = replay.update(raw, us, 100000);
      if (previousUs && us > previousUs && us - previousUs < 100000) {
        const float dt = (us - previousUs) * 1e-6f, alpha = dt / (.10f + dt);
        rawSpeed += alpha * ((raw - previousRaw) * 360 / 3.296f / dt - rawSpeed);
        filteredSpeed += alpha * ((filtered - previousFiltered) * 360 / 3.296f / dt - filteredSpeed);
        peakRaw = fmaxf(peakRaw, fabsf(rawSpeed)); peakFiltered = fmaxf(peakFiltered, fabsf(filteredSpeed));
      }
      previousRaw = raw; previousFiltered = filtered; previousUs = us;
    }
    std::cout << "Recorded telemetry replay: raw peak " << peakRaw
              << " deg/s; median peak " << peakFiltered << " deg/s\n";
    assert(peakRaw > 0 && peakFiltered < peakRaw);
  }
  ServoPotFilter filter;
  uint64_t sampleUs = 1000000;
  assert(filter.update(1.5, sampleUs, 100000) == 1.5);
  for (float v : {1.8f, 1.9f, 1.5f, 1.5f, 1.5f}) {
    sampleUs += 20000; assert(filter.update(v, sampleUs, 100000) == 1.5);
  }
  // Genuine motion and a real wrap must pass, so overspeed remains observable.
  for (int i = 0; i < 3; ++i) { sampleUs += 20000; filter.update(3.29, sampleUs, 100000); }
  assert(fabsf(filter.value - 3.29f) < .0001f);
  for (int i = 0; i < 3; ++i) { sampleUs += 20000; filter.update(.01, sampleUs, 100000); }
  assert(fabsf(filter.value - .01f) < .0001f);
  assert(isnan(filter.update(NAN, sampleUs + 20000, 100000)));
  sampleUs += 200000; assert(filter.update(2, sampleUs, 100000) == 2);
  TiltCalibration c;
  assert(validTiltCalibration(c));
  assert(fabsf(tiltAngleFromVolts(1.652f, c) - 180) < .001f);
  c.zeroDeg = 180; c.minAngleDeg = -90; c.maxAngleDeg = 90;
  assert(fabsf(tiltAngleFromVolts(1.652f, c)) < .001f);
  assert(tiltMovingOutOfLimits(90, 1, c));
  assert(!tiltMovingOutOfLimits(90, -1, c));
  assert(tiltMovingOutOfLimits(-100, -1, c));
  assert(!tiltMovingOutOfLimits(-100, 1, c));
  c.maxVolts = c.minVolts; assert(!validTiltCalibration(c));
  TiltSweep sweep;
  sweep.start(1.65, 5, 1, 1000000);
  uint64_t now = 1000000;
  for (float voltage = 1.66; voltage <= 3.3; voltage += .01f) {
    now += 100000; assert(sweep.observe(voltage, now) == TiltSweepStatus::Running);
  }
  now += 100000; assert(sweep.observe(.004, now) == TiltSweepStatus::Running);
  for (float voltage = .014; voltage < 1.64; voltage += .01f) { now += 100000; sweep.observe(voltage, now); }
  now += 100000; assert(sweep.observe(1.65, now) == TiltSweepStatus::Complete);
  assert(sweep.minVolts <= .0041 && sweep.maxVolts >= 3.28);
  // Two rotations must not stop at the first return to the starting voltage.
  sweep.start(1.65, 5, 1, 1000000, 3.296f, 2); now = 1000000;
  for (int turn = 0; turn < 2; ++turn) {
    for (float v = 1.66; v <= 3.3; v += .01f) { now += 100000; assert(sweep.observe(v, now) == TiltSweepStatus::Running); }
    now += 100000; assert(sweep.observe(.004, now) == TiltSweepStatus::Running);
    for (float v = .014; v < 1.64; v += .01f) { now += 100000; assert(sweep.observe(v, now) == TiltSweepStatus::Running); }
    now += 100000;
    assert(sweep.observe(1.65, now) == (turn == 0 ? TiltSweepStatus::Running : TiltSweepStatus::Complete));
    assert(sweep.completedRotations == turn + 1);
  }
  assert(sweep.progressDeg == 720);
  // Backward slip away from an endpoint cannot fabricate completed turns.
  sweep.start(1.65, 5, 1, 1000000, 3.296f, 5);
  sweep.observe(2.5, 1100000);
  sweep.observe(1.5, 1200000);
  sweep.observe(2.5, 1300000);
  assert(sweep.completedRotations == 0 && !sweep.wrapped);
  // Starting beside the seam must not relearn the opposite direction after wrap.
  sweep.start(3.28, 5, 1, 1000000, 3.296f, 5);
  sweep.edgeSeen = true; sweep.edgeVolts = 3.28;
  sweep.observe(3.3, 1100000); sweep.observe(.004, 1200000);
  sweep.observe(.03, 1300000); sweep.observe(.06, 1400000);
  assert(sweep.direction == 1 && sweep.completedRotations == 0);
  // Gradual high-to-low rollover must not be mistaken for reverse travel.
  sweep.start(1.65, 5, 1, 1000000); now = 1000000;
  for (float v = 1.66; v <= 3.3; v += .01f) { now += 100000; sweep.observe(v, now); }
  const float seamProgress = sweep.progressDeg;
  for (float v = 3.24; v > .03; v -= .04f) {
    now += 50000; assert(sweep.observe(v, now) == TiltSweepStatus::Running);
    assert(sweep.rolloverActive && sweep.progressDeg >= seamProgress);
  }
  now += 50000; sweep.observe(.004, now); assert(!sweep.rolloverActive && sweep.wrapped);
  for (float v = .014; v < 1.64; v += .01f) { now += 100000; sweep.observe(v, now); }
  now += 100000; assert(sweep.observe(1.65, now) == TiltSweepStatus::Complete);
  // Mirror the gradual seam in the decreasing-voltage direction.
  sweep.start(1.65, 5, -1, 1000000); now = 1000000;
  for (float v = 1.64; v >= .004; v -= .01f) { now += 100000; sweep.observe(v, now); }
  now += 100000; sweep.observe(.004, now);
  for (float v = .05; v < 3.27; v += .04f) {
    now += 50000; assert(sweep.observe(v, now) == TiltSweepStatus::Running);
    assert(sweep.rolloverActive);
  }
  now += 50000; sweep.observe(3.3, now); assert(!sweep.rolloverActive && sweep.wrapped);
  for (float v = 3.29; v > 1.66; v -= .01f) { now += 100000; sweep.observe(v, now); }
  now += 100000; assert(sweep.observe(1.65, now) == TiltSweepStatus::Complete);
  // A stalled or reversed seam cannot run indefinitely.
  sweep.start(3.28, 5, 1, 1000000); sweep.observe(3.3, 1100000);
  sweep.observe(3.2, 1200000); assert(sweep.rolloverActive);
  assert(sweep.observe(3.1, 9200001) == TiltSweepStatus::Fault);
  // Requested increasing, physically decreasing: learn the trend and finish.
  sweep.start(1.65, 5, 1, 1000000); now = 1000000;
  for (float voltage = 1.64; voltage >= .004; voltage -= .01f) { now += 100000; sweep.observe(voltage, now); }
  now += 100000; assert(sweep.observe(3.3, now) == TiltSweepStatus::Running);
  for (float voltage = 3.29; voltage > 1.66; voltage -= .01f) { now += 100000; sweep.observe(voltage, now); }
  now += 100000; assert(sweep.observe(1.65, now) == TiltSweepStatus::Complete);
  assert(sweep.observedDirection == -1);
  sweep.start(1.65, 5, 1, 1000000);
  assert(sweep.observe(1.65, 7000000) == TiltSweepStatus::Running);
  assert(sweep.observe(1.65, 61000001) == TiltSweepStatus::Fault);
  assert(sweep.fault == TiltSweepFault::NoMovement);
  sweep.start(1.65, 5, 1, 1000000);
  assert(sweep.observe(NAN, 1100000) == TiltSweepStatus::Fault);
  assert(sweep.fault == TiltSweepFault::InvalidVoltage);
  sweep.start(1.65, 5, 1, 1000000);
  assert(sweep.observe(1.65, 300000000) == TiltSweepStatus::Fault);
  assert(sweep.fault == TiltSweepFault::Timeout);
}
