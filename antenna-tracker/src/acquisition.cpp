#include <Arduino.h>
#include <SPI.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include "acquisition.h"
#include "sampling_config.h"
#include "adc_sequence.h"
#include "channel_scaling.h"
#include "current_readings.h"
#include "servo_control.h"

namespace {
constexpr uint32_t CAPACITY = 4096, BATCH = 128;
AdcScan ring[CAPACITY], latest = {};
constexpr uint32_t KEPT_READINGS = ADC_CONSECUTIVE_READINGS - ADC_DISCARDED_READINGS;
AdcScan burst[KEPT_READINGS];
uint32_t head = 0, tail = 0;
AcquisitionStats stats = {};
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
TaskHandle_t adcTaskHandle = nullptr;
esp_timer_handle_t timer = nullptr;
uint32_t crcTable[256];
int requestedChannel = -1, appliedChannel = -1;

uint16_t command(uint8_t channel) {
  return 0x1800 | (uint16_t(channel) << 7) | (ADC_DOUBLE_RANGE ? 0x0040 : 0);
}
uint16_t transfer(uint16_t value) {
  gpio_set_level(GPIO_NUM_18, 0);
  const uint16_t result = SPI.transfer16(value);
  gpio_set_level(GPIO_NUM_18, 1);
  // Exceeds datasheet quiet/acquisition time, independently of software overhead.
  delayMicroseconds(ADC_QUIET_US);
  return result;
}
void tick(void *) { xTaskNotifyGive(adcTaskHandle); }
void adcTask(void *) {
  // This task is the only owner of SPI after startup. No per-frame mutex calls.
  SPI.beginTransaction(SPISettings(ADC_SPI_HZ, MSBFIRST, SPI_MODE0));
  transfer(command(adcBurstChannel(0, ADC_CONSECUTIVE_READINGS)));
  transfer(command(adcBurstChannel(1, ADC_CONSECUTIVE_READINGS)));
  uint32_t sequence = 0;
  uint32_t burstsSinceYield = 0;
  int activeChannel = -1;
  for (;;) {
    const uint32_t ticks = ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    portENTER_CRITICAL(&mux); const int selected = requestedChannel; portEXIT_CRITICAL(&mux);
    if (selected != activeChannel) {
      SPI.endTransaction();
      SPI.beginTransaction(SPISettings(selected < 0 ? ADC_SPI_HZ : ADC_DIAGNOSTIC_SPI_HZ, MSBFIRST, SPI_MODE0));
      // Flush old channel requests and allow settling before retaining results.
      for (int i = 0; i < 4; ++i) {
        transfer(command(selected < 0 ? 0 : selected)); delayMicroseconds(100);
      }
      if (selected < 0) {
        transfer(command(adcBurstChannel(0, ADC_CONSECUTIVE_READINGS)));
        transfer(command(adcBurstChannel(1, ADC_CONSECUTIVE_READINGS)));
      }
      activeChannel = selected;
    }
    const uint64_t started = esp_timer_get_time();
    const uint32_t baseSequence = sequence + (ticks - 1) * KEPT_READINGS;
    sequence += ticks * KEPT_READINGS;
    memset(burst, 0, sizeof(burst));
    // Account for N+2 latency across repeated conversions and scan boundaries.
    auto store = [&](uint8_t channel, uint32_t index, uint16_t response) {
        AdcScan &reading = burst[index];
        if (channel == 0 || activeChannel >= 0) {
          reading.sequence = baseSequence + index + 1;
          reading.deviceUs = esp_timer_get_time();
        }
        reading.raw[channel] = response & 0x0FFF;
        if ((response >> 12) == channel) reading.valid |= uint16_t(1) << channel;
      };
    if (activeChannel < 0) {
      readAdcBurst(ADC_CONSECUTIVE_READINGS, ADC_DISCARDED_READINGS,
        [](uint8_t channel) { return transfer(command(channel)); }, store);
    } else {
      for (uint32_t index = 0; index < ADC_CONSECUTIVE_READINGS; ++index) {
        const uint16_t response = transfer(command(activeChannel));
        if (index >= ADC_DISCARDED_READINGS) store(activeChannel, index - ADC_DISCARDED_READINGS, response);
      }
    }
    const AdcScan &scan = burst[KEPT_READINGS - 1];
    totalCurrentAmps = scan.valid & (1 << 15) ? adcToScaled(scan.raw[15], 15) : NAN;
    output5vCurrentAmps = scan.valid & (1 << 14) ? adcToScaled(scan.raw[14], 14) : NAN;
    servoCurrentAmps = scan.valid & (1 << 13) ? adcToScaled(scan.raw[13], 13) : NAN;
    output3v3CurrentAmps = scan.valid & (1 << 12) ? adcToScaled(scan.raw[12], 12) : NAN;
    output3v3VoltageVolts = scan.valid & (1 << 11) ? adcToScaled(scan.raw[11], 11) : NAN;
    const uint32_t duration = esp_timer_get_time() - started;
    portENTER_CRITICAL(&mux);
    latest = scan; appliedChannel = activeChannel; stats.scans += KEPT_READINGS; stats.missedTicks += ticks - 1;
    if (duration > stats.maxScanUs) stats.maxScanUs = duration;
    portEXIT_CRITICAL(&mux);
    for (const AdcScan &reading : burst) {
      portENTER_CRITICAL(&mux);
      if (reading.valid != (activeChannel < 0 ? 0xFFFF : (1 << activeChannel))) ++stats.invalidScans;
      if (head - tail == CAPACITY) { ++tail; ++stats.ringDrops; }
      ring[head++ % CAPACITY] = reading;
      portEXIT_CRITICAL(&mux);
    }
    // An overloaded timer can leave notifications permanently pending. Allow
    // core 1's idle task to run even then, preventing watchdog reset loops.
    if (activeChannel >= 0 || ++burstsSinceYield >= 32) {
      burstsSinceYield = 0;
      vTaskDelay(1);
    }
  }
}
uint32_t crc32(const uint8_t *data, size_t size) {
  uint32_t crc = 0xFFFFFFFF;
  while (size--) crc = crcTable[(crc ^ *data++) & 255] ^ (crc >> 8);
  return ~crc;
}
}

bool startAdcAcquisition() {
  for (uint32_t i = 0; i < 256; ++i) {
    uint32_t value = i;
    for (int bit = 0; bit < 8; ++bit) value = (value >> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
    crcTable[i] = value;
  }
  // Initialize at a conservative clock before changing to high-speed acquisition.
  digitalWrite(D9, HIGH); pinMode(D9, OUTPUT);
  digitalWrite(D10, HIGH); pinMode(D10, OUTPUT);
  SPI.begin(D13, D12, D11, D9);
  delay(10);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  transfer(0x4200); transfer(0); delay(1); transfer(0x4100); transfer(command(0));
  SPI.endTransaction();
  if (!isfinite(adcSampleHz) || adcSampleHz <= 0 || adcSampleHz > 10000) return false;
  if (xTaskCreatePinnedToCore(adcTask, "adc-10k", 4096, nullptr, 23, &adcTaskHandle, 1) != pdPASS) return false;
  esp_timer_create_args_t args = {};
  args.callback = tick; args.name = "adc-clock";
  // Keep elapsed callbacks: missed notifications are counted rather than hidden.
  if (esp_timer_create(&args, &timer) != ESP_OK ||
      esp_timer_start_periodic(timer, adcBurstPeriodUs(adcSampleHz, KEPT_READINGS)) != ESP_OK) {
    if (timer) esp_timer_delete(timer);
    vTaskDelete(adcTaskHandle); adcTaskHandle = nullptr; return false;
  }
  return true;
}

void sendAdcBatches() {
  static uint8_t packet[11 + 14 + BATCH * 30];
  static uint32_t lastSend = 0;
  // A full USB TX buffer must still be flushed by write(). Returning here
  // when availableForWrite() is zero can starve batches behind text telemetry.
  uint16_t count = 0;
  portENTER_CRITICAL(&mux);
  const uint32_t available = head - tail;
  portEXIT_CRITICAL(&mux);
  if (!available || (available < BATCH && uint32_t(millis() - lastSend) < 10)) return;
  count = available < BATCH ? available : BATCH;
  // Copy each scan under a short lock; never hold the lock during USB writes.
  uint32_t baseSequence = 0;
  uint64_t baseUs = 0;
  for (uint16_t i = 0; i < count; ++i) {
    portENTER_CRITICAL(&mux);
    const AdcScan scan = ring[tail % CAPACITY];
    if (i && (scan.deviceUs - baseUs > 65535 || uint32_t(scan.sequence - baseSequence) > 65535)) {
      portEXIT_CRITICAL(&mux); count = i; break;
    }
    ++tail;
    portEXIT_CRITICAL(&mux);
    if (!i) { baseSequence = scan.sequence; baseUs = scan.deviceUs; }
    uint8_t *record = packet + 21 + i * 30;
    const uint16_t sequenceDelta = scan.sequence - baseSequence, usDelta = scan.deviceUs - baseUs;
    memcpy(record, &sequenceDelta, 2); memcpy(record + 2, &usDelta, 2); memcpy(record + 4, &scan.valid, 2);
    for (int pair = 0; pair < 8; ++pair) {
      const uint16_t a = scan.raw[pair * 2], b = scan.raw[pair * 2 + 1];
      record[6 + pair * 3] = a;
      record[7 + pair * 3] = (a >> 8) | ((b & 15) << 4);
      record[8 + pair * 3] = b >> 4;
    }
  }
  memcpy(packet, "\0ATB2", 5);
  const uint16_t length = 14 + count * 30;
  memcpy(packet + 5, &length, 2); memcpy(packet + 7, &count, 2);
  memcpy(packet + 9, &baseSequence, 4); memcpy(packet + 13, &baseUs, 8);
  const uint32_t crc = crc32(packet + 7, length);
  memcpy(packet + 7 + length, &crc, 4);
  const size_t size = 11 + length;
  size_t sent = 0;
  const uint32_t started = millis();
  while (sent < size) {
    const size_t written = Serial.write(packet + sent, size - sent);
    if (!written) {
      if (uint32_t(millis() - started) > 100) break;
      delay(1); continue;
    }
    sent += written;
  }
  lastSend = millis();
}
int adcDiagnosticChannel() {
  portENTER_CRITICAL(&mux); const int channel = appliedChannel; portEXIT_CRITICAL(&mux);
  return channel;
}
bool handleAdcCommand(const char *line) {
  if (strncmp(line, "ADC", 3)) return false;
  int channel = -1, end = 0;
  if (!strcmp(line, "ADC CHANNEL ALL")) channel = -1;
  else if (sscanf(line, "ADC CHANNEL %d %n", &channel, &end) != 1 || line[end] || channel < 0 || channel > 15) {
    queueControlMessage("ADC error: expected ADC CHANNEL 0..15 or ALL"); return true;
  }
  portENTER_CRITICAL(&mux); requestedChannel = channel; portEXIT_CRITICAL(&mux);
  return true;
}
AcquisitionStats acquisitionStats() {
  portENTER_CRITICAL(&mux); const auto value = stats; portEXIT_CRITICAL(&mux); return value;
}
void latestAdcScan(AdcScan &scan) {
  portENTER_CRITICAL(&mux); scan = latest; portEXIT_CRITICAL(&mux);
}
