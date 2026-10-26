#pragma once
constexpr int WIFI_IF_AP = 1, WIFI_BW_HT20 = 20, ESP_OK = 0;
inline int esp_wifi_set_bandwidth(int, int) { return ESP_OK; }
