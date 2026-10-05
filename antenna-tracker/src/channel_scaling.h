#pragma once
#include <stdint.h>

// Edit these values for your hardware. y = m * ADC input volts + b.
// Rebuild and upload firmware after changing this file.
constexpr float ADC_REFERENCE_VOLTS = 2.5f;
constexpr bool ADC_DOUBLE_RANGE = true;

struct ChannelScaling {
  float m;
  float b;
};

constexpr ChannelScaling ADC_CHANNEL_SCALING[16] = {
  {1.0f, 0.0f}, // CH0
  {1.0f, 0.0f}, // CH1
  {1.0f, 0.0f}, // CH2
  {1.0f, 0.0f}, // CH3
  {1.0f, 0.0f}, // CH4
  {1.0f, 0.0f}, // CH5 S3 FB (V)
  {1.0f, 0.0f}, // CH6 PAN FB (V)
  {1.0f, 0.0f}, // CH7 TILT FB (V)
  {1.0f, 0.0f}, // CH8: disconnected
  {1.0f, 0.0f}, // CH9: disconnected
  {1.0f, 0.0f}, // CH10: disconnected
  {1.0f, 0.0f}, // CH11: 3.3 V output voltage (volts)
  {4000.0f, 0.0f}, // CH12: 3.3 V output current (amps)
  {4000.0f, 0.0f}, // CH13: servo current (amps) (trace cut)
  {4000.0f, 0.0f}, // CH14: 5 V output current (amps)
  {4000.0f, 0.0f}, // CH15: total current (amps)
};

inline float adcToVolts(uint16_t raw) {
  return raw * ADC_REFERENCE_VOLTS * (ADC_DOUBLE_RANGE ? 2.0f : 1.0f) / 4096.0f;
}

// channel must be 0..15; call only for a valid ADC reading.
inline float adcToScaled(uint16_t raw, uint8_t channel) {
  const ChannelScaling &scaling = ADC_CHANNEL_SCALING[channel];
  return scaling.m * adcToVolts(raw) + scaling.b;
}
