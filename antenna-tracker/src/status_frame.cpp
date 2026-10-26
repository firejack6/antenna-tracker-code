#include "status_frame.h"
#include "network_transport.h"
#include <string.h>

namespace {
uint32_t crcTable[256];
bool crcReady = false;
void initCrc() {
  if (crcReady) return;
  for (uint32_t i = 0; i < 256; ++i) {
    uint32_t value = i;
    for (int bit = 0; bit < 8; ++bit) value = value & 1 ? (value >> 1) ^ 0xEDB88320 : value >> 1;
    crcTable[i] = value;
  }
  crcReady = true;
}
uint32_t crc32(const uint8_t *data, size_t size) {
  initCrc();
  uint32_t crc = 0xFFFFFFFF;
  while (size--) crc = crcTable[(crc ^ *data++) & 255] ^ (crc >> 8);
  return ~crc;
}
}

bool sendStatusFrame(const StatusFrame &frame) {
  uint8_t packet[11 + sizeof(StatusFrame)];
  memcpy(packet, "\0ATS1", 5);
  const uint16_t length = sizeof(StatusFrame);
  memcpy(packet + 5, &length, 2);
  memcpy(packet + 7, &frame, length);
  const uint32_t crc = crc32(packet + 7, length);
  memcpy(packet + 7 + length, &crc, 4);
  const size_t size = 11 + length;
  return writeTelemetryBytes(packet, size) == size;
}
