#pragma once
#include <stdint.h>

// true: PC joins the ESP hotspot. false: ESP joins your existing Wi-Fi.
constexpr bool WIFI_ACCESS_POINT = true;
constexpr uint8_t WIFI_AP_CHANNEL = 1;
// Avoid 40 MHz channel bonding on the crowded 2.4 GHz band. This still leaves
// ample capacity for telemetry and improves interoperability with PC adapters.
constexpr bool WIFI_AP_20MHZ = true;
constexpr uint8_t WIFI_AP_ADDRESS[4] = {192, 168, 20, 1};
constexpr uint8_t WIFI_AP_NETMASK[4] = {255, 255, 255, 0};
constexpr char WIFI_SSID[] = "antenna-tracker";
constexpr char WIFI_PASSWORD[] = "changeme123"; // At least 8 characters for hotspot.
constexpr uint16_t TELEMETRY_TCP_PORT = 9000;
constexpr uint32_t TCP_NO_PROGRESS_TIMEOUT_MS = 5000; // Keep temporary stalls connected.
