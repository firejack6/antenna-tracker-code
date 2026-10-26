#pragma once
#include <Arduino.h>

void startTelemetryNetwork();
bool pollTelemetryNetwork(); // Sole writer task owns socket, including commands.
bool telemetryReady(); // Flush pending bytes; false while backpressure persists.
Stream &telemetryStream();
void closeTelemetryClient();
void flushTelemetry();
size_t writeTelemetryBytes(const uint8_t *data, size_t size);
struct TcpHealth {
  uint32_t stalls = 0, failedWrites = 0, maxWriteMs = 0, connections = 0;
  uint32_t pendingBytes = 0, closeReason = 0;
};
TcpHealth telemetryNetworkHealth(); // Called by the socket owner task.
