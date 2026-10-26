#include <algorithm>
#include <cassert>
#include <deque>
#include <vector>
#include <cerrno>
#include "Arduino.h"
uint32_t fakeMillis = 0;
std::deque<int> sends;
std::vector<uint8_t> wire;
int send(int, const void *data, size_t size, int) {
  int action = sends.empty() ? int(size) : sends.front();
  if (!sends.empty()) sends.pop_front();
  if (action < 0) { errno = -action; return -1; }
  const size_t count = std::min(size, size_t(action));
  const auto *bytes = static_cast<const uint8_t *>(data);
  wire.insert(wire.end(), bytes, bytes + count);
  return int(count);
}
void readServoCommands(bool) {}
// Exercise the actual firmware transport, replacing only hardware/socket APIs.
#include "../../src/network_transport.cpp"
void reset() {
  fakeMillis = 0; health = {}; client.live = true;
  clearPending(); output.clear(); sends.clear(); wire.clear();
}
int main() {
  const uint8_t packet[] = {0, 'A', 'T', 'B', '2', 9, 8, 7, 6, 5};
  reset(); sends = {3, -EAGAIN};
  assert(writeTelemetryBytes(packet, sizeof(packet)) == sizeof(packet));
  fakeMillis = 750;
  assert(!telemetryReady()); // Old 500 ms cutoff must not close the socket.
  assert(client.live && telemetryStream().read() == 42);
  sends = {2, -EAGAIN};
  assert(!telemetryReady());
  fakeMillis = 1000;
  assert(!telemetryReady());
  assert(telemetryReady());
  assert(wire == std::vector<uint8_t>(packet, packet + sizeof(packet)));
  assert(health.failedWrites == 0);

  reset(); sends = {-EAGAIN};
  assert(writeTelemetryBytes(packet, sizeof(packet)) == sizeof(packet));
  fakeMillis = 4999; sends = {-EAGAIN}; assert(!telemetryReady()); assert(client.live);
  fakeMillis = 5000; sends = {-EAGAIN}; assert(!telemetryReady());
  assert(!client.live && health.closeReason == 3 && health.failedWrites == 1);

  reset(); sends = {2}; writeTelemetryBytes(packet, sizeof(packet));
  fakeMillis = 4500; sends = {1}; assert(!telemetryReady());
  fakeMillis = 8000; sends = {-EAGAIN}; assert(!telemetryReady()); assert(client.live);
  assert(telemetryReady()); // Timeout resets after any actual progress.

  reset(); sends = {2}; writeTelemetryBytes(packet, sizeof(packet));
  sends = {-EAGAIN, -EAGAIN};
  const uint8_t status[] = {'T', 'i', 'm', 'e', '\n'};
  telemetryStream().write(status, sizeof(status)); flushTelemetry();
  assert(telemetryReady());
  std::vector<uint8_t> expected(packet, packet + sizeof(packet));
  expected.insert(expected.end(), status, status + sizeof(status));
  assert(wire == expected); // Text never interleaves inside a partial ADC packet.

  reset(); sends = {-ECONNRESET};
  assert(writeTelemetryBytes(packet, sizeof(packet)) == 0);
  assert(!client.live && health.closeReason == 2 && pendingSize == 0);
}
