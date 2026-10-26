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
  uint32_t queued, capacity;
};
bool startAdcAcquisition();
bool sendAdcBatches(); // True after queuing a batch; TCP writer task only.
AcquisitionStats acquisitionStats();
void latestAdcScan(AdcScan &scan);
bool handleAdcCommand(const char *line);
int adcDiagnosticChannel(); // -1 = normal scan, 0..15 = single channel
bool adcStreamEnabled(); // False = lean TCP: no ATB2 batches (local ADC still runs).
