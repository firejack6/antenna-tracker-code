#pragma once
#include <stdint.h>

// One burst emits 'kept' readings/channel. Keep the requested output rate
// independent of burst size, rounding the hardware timer interval to 1 us.
constexpr uint64_t adcBurstPeriodUs(double sampleHz, uint32_t kept) {
  return uint64_t(1000000.0 * kept / sampleHz + 0.5);
}

// Channel order of conversion results; requests run two frames ahead.
constexpr uint8_t adcBurstChannel(uint32_t frame, uint32_t readings) {
  return (frame / readings) & 15;
}

// Emit every retained conversion, without averaging. The caller
// primes the SPI pipeline with requests for result frames 0 and 1 once.
template <typename Transfer, typename Store>
void readAdcBurst(uint32_t readings, uint32_t discarded, Transfer transfer, Store store) {
  for (uint32_t frame = 0; frame < 16 * readings; ++frame) {
    const uint8_t channel = adcBurstChannel(frame, readings);
    const uint16_t response = transfer(adcBurstChannel(frame + 2, readings));
    const uint32_t index = frame % readings;
    if (index >= discarded) store(channel, index - discarded, response);
  }
}
