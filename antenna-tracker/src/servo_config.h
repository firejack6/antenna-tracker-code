#pragma once
#include <stdint.h>

struct ServoConfig {
  const char *name;
  int gpio;
  uint32_t minPulseUs, centerPulseUs, maxPulseUs;
  uint32_t minFrequencyHz, centerFrequencyHz, maxFrequencyHz;
  uint32_t presetMinPulseUs, presetCenterPulseUs, presetMaxPulseUs;
};

// Position is set by pulse width. Frequency is normally fixed at 50 Hz.
// Edit limits for your servos, then rebuild/upload. Outputs start OFF.
// These are physical ESP32 GPIO numbers, passed directly to ESP-IDF LEDC.
// PAN GPIO1 = A0/D17; TILT GPIO2 = A1/D18; S3 GPIO3 = A2/D19.
// Edit these presets here. Include this header to use the same values in code.
// Browser-saved overrides do not modify these firmware constants.
constexpr uint32_t panMinPulseUs = 500;
constexpr uint32_t panCenterPulseUs = 1500;
constexpr uint32_t panMaxPulseUs = 2500;

constexpr uint32_t tiltMinPulseUs = 500;
constexpr uint32_t tiltCenterPulseUs = 2400;
constexpr uint32_t tiltMaxPulseUs = 2500;

constexpr uint32_t s3MinPulseUs = 500;
constexpr uint32_t s3CenterPulseUs = 1500;
constexpr uint32_t s3MaxPulseUs = 2500;

constexpr ServoConfig SERVO_CONFIG[3] = {
  // Absolute pulse/frequency limits, followed by UI Min/Center/Max presets.
  {"PAN",  1, 500, 1500, 2500, 50, 50, 50, panMinPulseUs, panCenterPulseUs, panMaxPulseUs},
  {"TILT", 2, 500, 1500, 2500, 50, 50, 50, tiltMinPulseUs, tiltCenterPulseUs, tiltMaxPulseUs},
  {"S3",   3, 500, 1500, 2500, 50, 50, 50, s3MinPulseUs, s3CenterPulseUs, s3MaxPulseUs},
};
