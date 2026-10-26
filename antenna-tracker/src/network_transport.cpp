#include <WiFi.h>
#include <esp_wifi.h>
#include <lwip/sockets.h>
#include <errno.h>
#include "network_config.h"
#include "network_transport.h"
#include "servo_control.h"

namespace {
WiFiServer server(TELEMETRY_TCP_PORT);
WiFiClient client;
bool listening = false;
TcpHealth health;
uint8_t pending[6144]; // Own partial packets until every byte has been sent.
size_t pendingSize = 0, pendingOffset = 0;
uint32_t pendingStarted = 0, lastProgress = 0;
bool stallEpisode = false;

void clearPending() { pendingSize = pendingOffset = 0; stallEpisode = false; }
void failWrite(uint32_t reason) {
  ++health.failedWrites; health.closeReason = reason;
  Serial.printf("TCP closed: reason=%lu pending=%u\n", (unsigned long)reason, unsigned(pendingSize - pendingOffset));
  clearPending(); client.stop();
}

void drainSocket() {
  if (pendingOffset == pendingSize) return;
  const uint32_t elapsed = millis() - pendingStarted;
  if (elapsed > health.maxWriteMs) health.maxWriteMs = elapsed;
  if (!client.connected()) { failWrite(1); return; }
  const int count = ::send(client.fd(), pending + pendingOffset, pendingSize - pendingOffset, MSG_DONTWAIT);
  if (count > 0) {
    pendingOffset += count; lastProgress = millis(); stallEpisode = false;
    if (pendingOffset == pendingSize) clearPending();
  } else if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
    if (errno != EINTR && !stallEpisode) { ++health.stalls; stallEpisode = true; }
    // Keep the same connection and packet offset through transient stalls.
    // The caller yields and processes incoming controls between retries.
    if (uint32_t(millis() - lastProgress) >= TCP_NO_PROGRESS_TIMEOUT_MS) failWrite(3);
  } else { failWrite(2); }
}

size_t writeSocket(const uint8_t *data, size_t size) {
  drainSocket();
  if (!client.connected()) return 0;
  const size_t remaining = pendingSize - pendingOffset;
  if (size > sizeof(pending) - remaining) { failWrite(4); return 0; }
  if (remaining && pendingOffset) memmove(pending, pending + pendingOffset, remaining);
  pendingOffset = 0; pendingSize = remaining;
  if (!remaining) pendingStarted = lastProgress = millis();
  memcpy(pending + pendingSize, data, size); pendingSize += size;
  drainSocket();
  // Accepted into our owned queue; the next iteration completes partial sends.
  return client.connected() ? size : 0;
}

// Coalesce status lines into one write instead of dozens of tiny TCP packets.
class BufferedTelemetry : public Stream {
  uint8_t buffer[2048];
  size_t used = 0;
public:
  using Print::write;
  void clear() { used = 0; }
  void flush() override {
    if (!used) return;
    const size_t size = used; used = 0;
    writeSocket(buffer, size);
  }
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t *data, size_t size) override {
    if (size > sizeof(buffer)) { flush(); return writeSocket(data, size); }
    if (used + size > sizeof(buffer)) flush();
    memcpy(buffer + used, data, size); used += size;
    return size;
  }
  int available() override { return client.available(); }
  int read() override { return client.read(); }
  int peek() override { return client.peek(); }
} output;
}

void startTelemetryNetwork() {
  WiFi.persistent(false);
  if (WIFI_ACCESS_POINT) {
    WiFi.mode(WIFI_AP);
    const IPAddress address(WIFI_AP_ADDRESS[0], WIFI_AP_ADDRESS[1], WIFI_AP_ADDRESS[2], WIFI_AP_ADDRESS[3]);
    const IPAddress netmask(WIFI_AP_NETMASK[0], WIFI_AP_NETMASK[1], WIFI_AP_NETMASK[2], WIFI_AP_NETMASK[3]);
    if (!WiFi.softAPConfig(address, address, netmask)) {
      Serial.println("Wi-Fi hotspot address configuration failed"); return;
    }
    if (!WiFi.softAP(WIFI_SSID, WIFI_PASSWORD, WIFI_AP_CHANNEL, false, 1)) {
      Serial.println("Wi-Fi hotspot failed"); return;
    }
    if (WIFI_AP_20MHZ && esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20) != ESP_OK)
      Serial.println("Wi-Fi hotspot: could not select 20 MHz bandwidth");
    Serial.printf("Wi-Fi hotspot: %s\n", WIFI_SSID);
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.println("Joining configured Wi-Fi...");
  }
  WiFi.setSleep(false);
}

bool pollTelemetryNetwork() {
  const bool available = WIFI_ACCESS_POINT ? WiFi.softAPIP() != IPAddress(0, 0, 0, 0)
                                           : WiFi.status() == WL_CONNECTED;
  if (!available) {
    output.clear();
    clearPending(); health.closeReason = 5;
    client.stop();
    if (listening) server.end();
    listening = false; return false;
  }
  if (!listening) {
    server.begin(); listening = true;
    Serial.printf("TCP telemetry: %s:%u\n",
      (WIFI_ACCESS_POINT ? WiFi.softAPIP() : WiFi.localIP()).toString().c_str(), TELEMETRY_TCP_PORT);
  }
  if (!client.connected()) {
    output.clear();
    clearPending();
    readServoCommands(true); // Never combine command fragments across connections.
    client.stop();
    client = server.available();
    if (client) { ++health.connections; client.setNoDelay(true); client.setTimeout(1); Serial.println("TCP dashboard connected"); }
  } else {
    // Only one dashboard owns the control connection; reject additional clients.
    WiFiClient extra = server.available();
    if (extra) extra.stop();
  }
  drainSocket();
  return client.connected();
}

Stream &telemetryStream() { return output; }
TcpHealth telemetryNetworkHealth() { auto value = health; value.pendingBytes = pendingSize - pendingOffset; return value; }
bool telemetryReady() { drainSocket(); return client.connected() && pendingSize == pendingOffset; }
void closeTelemetryClient() { output.clear(); clearPending(); client.stop(); }
void flushTelemetry() { output.flush(); }
size_t writeTelemetryBytes(const uint8_t *data, size_t size) {
  output.flush(); // Pending replies precede complete binary packets.
  return writeSocket(data, size);
}
