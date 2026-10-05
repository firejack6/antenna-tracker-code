#include <Arduino.h>
#include <driver/ledc.h>
#include <driver/gpio.h>
#include <string.h>
#include "servo_config.h"
#include "servo_control.h"
#include "acquisition.h"
extern bool handleSensorCommand(const char *line);

namespace {
struct ControlMessage { char text[96]; };
QueueHandle_t messages = nullptr;
portMUX_TYPE servoMux = portMUX_INITIALIZER_UNLOCKED;
bool ready[3] = {}, enabled[3] = {};
bool armed = false, estopLatched = false;
uint32_t pulseUs[3] = {}, frequencyHz[3] = {};
bool validConfig(const ServoConfig &c) {
  return c.minPulseUs > 0 && c.minPulseUs <= c.centerPulseUs && c.centerPulseUs <= c.maxPulseUs &&
    c.minFrequencyHz > 0 && c.minFrequencyHz <= c.centerFrequencyHz && c.centerFrequencyHz <= c.maxFrequencyHz &&
    uint64_t(c.maxPulseUs) * c.maxFrequencyHz < 1000000 &&
    c.minPulseUs <= c.presetMinPulseUs && c.presetMinPulseUs <= c.presetCenterPulseUs &&
    c.presetCenterPulseUs <= c.presetMaxPulseUs && c.presetMaxPulseUs <= c.maxPulseUs;
}
void stopOutput(int i) {
  ledc_stop(LEDC_LOW_SPEED_MODE, ledc_channel_t(i), 0);
  portENTER_CRITICAL(&servoMux);
  enabled[i] = false;
  portEXIT_CRITICAL(&servoMux);
}
void acknowledge(int i) {
  ControlMessage message = {};
  snprintf(message.text, sizeof(message.text), "Servo ack: %s PULSE=%lu FREQ=%lu ENABLE=%d", SERVO_CONFIG[i].name,
    (unsigned long)pulseUs[i], (unsigned long)frequencyHz[i], enabled[i]);
  queueControlMessage(message.text);
}
void safetyState() {
  ControlMessage message = {};
  snprintf(message.text, sizeof(message.text), "Servo safety: ARMED=%d ESTOP=%d", armed, estopLatched);
  queueControlMessage(message.text);
}
bool safetyCommand(const char *line) {
  if (strcmp(line, "ESTOP") && strncmp(line, "SERVOS ", 7)) return false;
  const char *action = !strcmp(line, "ESTOP") ? "ESTOP" : line + 7;
  if (!strcmp(action, "ESTOP") || !strcmp(action, "DISABLE")) {
    portENTER_CRITICAL(&servoMux);
    armed = false;
    if (!strcmp(action, "ESTOP")) estopLatched = true;
    portEXIT_CRITICAL(&servoMux);
    for (int i = 0; i < 3; ++i) if (ready[i]) stopOutput(i);
  } else if (!strcmp(action, "ENABLE")) {
    if (estopLatched) { queueControlMessage("Servo error: E-stop latched; clear it before enabling"); return true; }
    portENTER_CRITICAL(&servoMux); armed = true; portEXIT_CRITICAL(&servoMux);
  } else if (!strcmp(action, "CLEAR")) {
    // Clearing never restores PWM or arms the outputs.
    for (int i = 0; i < 3; ++i) if (ready[i]) stopOutput(i);
    portENTER_CRITICAL(&servoMux); armed = false; estopLatched = false; portEXIT_CRITICAL(&servoMux);
  } else { queueControlMessage("Servo error: expected SERVOS ENABLE, DISABLE, ESTOP, or CLEAR"); return true; }
  safetyState(); return true;
}
void command(const char *line) {
  if (safetyCommand(line)) return;
  char axis[8] = {}, tail[8] = {};
  unsigned long pulse = 0, frequency = 0;
  int consumed = 0;
  int i = -1;
  if (sscanf(line, "SERVO %7s", axis) != 1) { queueControlMessage("Servo error: invalid command"); return; }
  for (int n = 0; n < 3; ++n) if (!strcmp(axis, SERVO_CONFIG[n].name)) i = n;
  if (i < 0 || !ready[i]) { queueControlMessage("Servo error: unknown or unavailable output"); return; }
  if (sscanf(line, "SERVO %7s %7s %n", axis, tail, &consumed) == 2 &&
      !strcmp(tail, "OFF") && line[consumed] == '\0') {
    stopOutput(i); acknowledge(i); return;
  }
  consumed = 0;
  if (!armed || estopLatched) {
    queueControlMessage(estopLatched ? "Servo error: E-stop latched" : "Servo error: servos disabled; enable first"); return;
  }
  if (sscanf(line, "SERVO %7s %lu %lu %n", axis, &pulse, &frequency, &consumed) != 3 ||
      line[consumed] != '\0') { queueControlMessage("Servo error: expected SERVO axis pulse_us frequency_hz"); return; }
  const auto &c = SERVO_CONFIG[i];
  if (pulse < c.minPulseUs || pulse > c.maxPulseUs || frequency < c.minFrequencyHz || frequency > c.maxFrequencyHz ||
      uint64_t(pulse) * frequency >= 1000000) {
    queueControlMessage("Servo error: command outside configured limits"); return;
  }
  // ESP-IDF returns ESP_OK (zero), unlike Arduino ledcSetup's frequency return.
  if (ledc_set_freq(LEDC_LOW_SPEED_MODE, ledc_timer_t(i), frequency) != ESP_OK) {
    stopOutput(i); queueControlMessage("Servo error: frequency unavailable"); return;
  }
  const uint32_t actualHz = ledc_get_freq(LEDC_LOW_SPEED_MODE, ledc_timer_t(i));
  if (!actualHz) {
    stopOutput(i); queueControlMessage("Servo error: frequency readback unavailable"); return;
  }
  // get_freq() truncates fractional hertz. Use the requested nominal period;
  // divider quantization is much smaller than truncating 49.999 Hz to 49 Hz.
  const uint32_t duty = (uint64_t(pulse) * frequency * 16384 + 500000) / 1000000;
  if (duty >= 16384 || ledc_set_duty(LEDC_LOW_SPEED_MODE, ledc_channel_t(i), duty) != ESP_OK ||
      ledc_update_duty(LEDC_LOW_SPEED_MODE, ledc_channel_t(i)) != ESP_OK) {
    stopOutput(i); queueControlMessage("Servo error: PWM update failed"); return;
  }
  portENTER_CRITICAL(&servoMux);
  pulseUs[i] = pulse; frequencyHz[i] = frequency; enabled[i] = true;
  portEXIT_CRITICAL(&servoMux);
  acknowledge(i);
}
}

void initServoOutputs() {
  for (int i = 0; i < 3; ++i) {
    const auto &c = SERVO_CONFIG[i];
    if (!validConfig(c)) { Serial.println("Servo error: invalid configuration"); continue; }
    ledc_timer_config_t timer = {};
    timer.speed_mode = LEDC_LOW_SPEED_MODE; timer.duty_resolution = LEDC_TIMER_14_BIT;
    timer.timer_num = ledc_timer_t(i); timer.freq_hz = c.centerFrequencyHz; timer.clk_cfg = LEDC_USE_APB_CLK;
    if (ledc_timer_config(&timer) != ESP_OK) continue;
    ledc_channel_config_t channel = {};
    channel.gpio_num = c.gpio; channel.speed_mode = LEDC_LOW_SPEED_MODE;
    channel.channel = ledc_channel_t(i); channel.timer_sel = ledc_timer_t(i);
    channel.intr_type = LEDC_INTR_DISABLE; channel.duty = 0;
    ready[i] = ledc_channel_config(&channel) == ESP_OK;
    pulseUs[i] = c.centerPulseUs; frequencyHz[i] = c.centerFrequencyHz;
    if (ready[i]) stopOutput(i);
  }
}

void readServoCommands() {
  static char buffer[80]; static size_t used = 0; static bool overflow = false;
  for (int budget = 0; budget < 128 && Serial.available(); ++budget) {
    const char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      buffer[used] = '\0';
      if (overflow) queueControlMessage("Servo error: command too long");
      else if (used && !handleAdcCommand(buffer) && !handleSensorCommand(buffer)) command(buffer);
      used = 0; overflow = false;
    } else if (used < sizeof(buffer) - 1 && !overflow) buffer[used++] = ch;
    else overflow = true;
  }
}

void queueControlMessage(const char *text) {
  if (!messages) return;
  ControlMessage message = {};
  strlcpy(message.text, text, sizeof(message.text));
  xQueueSend(messages, &message, 0);
}

bool startControlReceiver() {
  messages = xQueueCreate(32, sizeof(ControlMessage));
  if (!messages) return false;
  return xTaskCreatePinnedToCore([](void *) {
    for (;;) { readServoCommands(); delay(1); }
  }, "control-rx", 4096, nullptr, 5, nullptr, 0) == pdPASS;
}

bool printControlMessages() {
  ControlMessage message;
  bool any = false;
  while (messages && xQueueReceive(messages, &message, 0) == pdPASS) {
    Serial.println(message.text); any = true;
  }
  return any;
}

void printServoStates() {
  bool active[3]; uint32_t pulses[3], frequencies[3];
  bool canCommand, stopped;
  portENTER_CRITICAL(&servoMux);
  memcpy(active, enabled, sizeof(active)); memcpy(pulses, pulseUs, sizeof(pulses)); memcpy(frequencies, frequencyHz, sizeof(frequencies));
  canCommand = armed; stopped = estopLatched;
  portEXIT_CRITICAL(&servoMux);
  Serial.printf("Servo safety: ARMED=%d ESTOP=%d\n", canCommand, stopped);
  for (int i = 0; i < 3; ++i) {
    const auto &c = SERVO_CONFIG[i];
    Serial.printf("Servo %s: GPIO=%d PMIN=%lu PCENTER=%lu PMAX=%lu FMIN=%lu FCENTER=%lu FMAX=%lu PULSE=%lu FREQ=%lu ENABLE=%d READY=%d UMIN=%lu UCENTER=%lu UMAX=%lu\n",
      c.name, c.gpio, (unsigned long)c.minPulseUs, (unsigned long)c.centerPulseUs, (unsigned long)c.maxPulseUs,
      (unsigned long)c.minFrequencyHz, (unsigned long)c.centerFrequencyHz, (unsigned long)c.maxFrequencyHz,
      (unsigned long)pulses[i], (unsigned long)frequencies[i], active[i], ready[i],
      (unsigned long)c.presetMinPulseUs, (unsigned long)c.presetCenterPulseUs,
      (unsigned long)c.presetMaxPulseUs);
  }
}
