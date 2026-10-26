#pragma once
#include "Arduino.h"
constexpr int WIFI_AP = 1, WIFI_STA = 2, WL_CONNECTED = 3;
class IPAddress {
  uint32_t value;
public:
  IPAddress(int a, int b, int c, int d) : value((a << 24) | (b << 16) | (c << 8) | d) {}
  bool operator!=(const IPAddress &other) const { return value != other.value; }
  std::string toString() const { return "192.168.20.1"; }
};
class WiFiClient {
public:
  bool live = false;
  bool connected() { return live; }
  explicit operator bool() const { return live; }
  int fd() { return 1; }
  void stop() { live = false; }
  void setNoDelay(bool) {}
  void setTimeout(int) {}
  int available() { return 1; }
  int read() { return 42; }
  int peek() { return 42; }
};
class WiFiServer {
public:
  explicit WiFiServer(int) {}
  void begin() {}
  void end() {}
  WiFiClient available() { return WiFiClient(); }
};
struct FakeWiFi {
  void persistent(bool) {}
  void mode(int) {}
  bool softAPConfig(IPAddress, IPAddress, IPAddress) { return true; }
  bool softAP(const char *, const char *, int, bool, int) { return true; }
  IPAddress softAPIP() { return IPAddress(192, 168, 20, 1); }
  IPAddress localIP() { return softAPIP(); }
  int status() { return WL_CONNECTED; }
  void setAutoReconnect(bool) {}
  void begin(const char *, const char *) {}
  void setSleep(bool) {}
};
inline FakeWiFi WiFi;
