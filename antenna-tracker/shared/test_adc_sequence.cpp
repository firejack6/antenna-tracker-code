// Host-only ADC pipeline regression; does not access hardware.
#include "../src/adc_sequence.h"
#include <assert.h>
#include <stdio.h>

int main() {
  assert(adcBurstPeriodUs(10000, 1) == 100);
  assert(adcBurstPeriodUs(10000, 8) == 800);
  assert(adcBurstPeriodUs(10000, 10) == 1000);
  assert(adcBurstPeriodUs(1000, 8) == 8000);
  assert(adcBurstPeriodUs(6400, 1) == 156);
  for (uint32_t readings = 1; readings <= 64; ++readings) {
   for (uint32_t discarded = 0; discarded < readings; ++discarded) {
    uint8_t pending[2] = {adcBurstChannel(0, readings), adcBurstChannel(1, readings)};
    uint32_t received = 0;
    bool corruptLast = false;
    auto transfer = [&](uint8_t request) -> uint16_t {
      const uint8_t channel = pending[0];
      pending[0] = pending[1]; pending[1] = request;
      const uint32_t position = received++ % (16 * readings);
      // Independently expect N results on CH0, then N on CH1, ...
      assert(channel == position / readings);
      const uint16_t count = channel * 100 + position % readings;
      const uint8_t tag = corruptLast && channel == 7 && (position + 1) % readings == 0 ? 8 : channel;
      return (uint16_t(tag) << 12) | count;
    };
    for (int scan = 0; scan < 4; ++scan) {
      corruptLast = scan == 3;
      uint16_t raw[64][16] = {}, valid[64] = {};
      uint32_t stores = 0;
      readAdcBurst(readings, discarded, transfer,
        [&](uint8_t channel, uint32_t index, uint16_t response) {
          assert(index < readings - discarded);
          ++stores;
          raw[index][channel] = response & 0x0FFF;
          if ((response >> 12) == channel) valid[index] |= uint16_t(1) << channel;
        });
      assert(stores == 16 * (readings - discarded));
      for (uint32_t index = 0; index < readings - discarded; ++index) {
        assert(valid[index] == (corruptLast && index == readings - discarded - 1 ? (0xFFFF ^ (1 << 7)) : 0xFFFF));
        for (int channel = 0; channel < 16; ++channel)
          assert(raw[index][channel] == channel * 100 + discarded + index);
      }
    }
    assert(received == 4 * 16 * readings);
   }
  }
  puts("PASS: all burst counts 1..64 and discard counts 0..N-1, pipeline, scan wrap, every retained reading and validity");
}
