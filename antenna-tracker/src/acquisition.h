#pragma once
#include <stdint.h>

struct AdcScan {
  uint32_t sequence;
  uint64_t deviceUs;
  uint16_t valid;
  uint16_t raw[16];
} __attribute__((packed));
static_assert(sizeof(AdcScan) == 46, "Wire format must stay 46 bytes");

struct AcquisitionStats {
  uint32_t scans, missedTicks, ringDrops, invalidScans, maxScanUs;
};
bool startAdcAcquisition();
void sendAdcBatches(); // Serial writer task only; never called by acquisition.
AcquisitionStats acquisitionStats();
void latestAdcScan(AdcScan &scan);
bool handleAdcCommand(const char *line);
int adcDiagnosticChannel(); // -1 = normal scan, 0..15 = single channel
