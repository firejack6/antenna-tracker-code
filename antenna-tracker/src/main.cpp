#include <Arduino.h>
#include <Wire.h>
#include <DFRobot_BMI323.h>
#include <DFRobot_BMM350.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include "acquisition.h"
#include "channel_scaling.h"
#include "current_readings.h"
#include "sampling_config.h"
#include "sensor_config.h"
#include "servo_control.h"

float totalCurrentAmps = NAN, output5vCurrentAmps = NAN, servoCurrentAmps = NAN;
float output3v3CurrentAmps = NAN, output3v3VoltageVolts = NAN;
float adcSampleHz = ADC_SAMPLE_HZ;
DFRobot_BMI323 bmi323(&Wire, 0x69);
DFRobot_BMM350_I2C bmm350(&Wire, 0x15);
portMUX_TYPE sensorMux = portMUX_INITIALIZER_UNLOCKED;
struct SensorState {
  DFRobot_BMI323::sSensorData accel, gyro;
  sBmm350MagData_t mag;
  bool bmiValid = false, magValid = false, rangeFailed = false;
  int accelRange = ACCEL_RANGE_G, gyroRange = GYRO_RANGE_DPS;
  uint32_t bmiReads = 0, magReads = 0;
};
SensorState sensors;
struct RangeRequest { int accel, gyro; };
QueueHandle_t rangeQueue;
bool bmiReady = false, magReady = false;

bool configureRanges(int accel, int gyro) {
  DFRobot_BMI323::eAccelRange_t a;
  DFRobot_BMI323::eGyroRange_t g;
  switch (accel) {
    case 2: a = bmi323.eAccelRange2G; break;
    case 4: a = bmi323.eAccelRange4G; break;
    case 8: a = bmi323.eAccelRange8G; break;
    case 16: a = bmi323.eAccelRange16G; break;
    default: return false;
  }
  switch (gyro) {
    case 125: g = bmi323.eGyroRange125DPS; break;
    case 250: g = bmi323.eGyroRange250DPS; break;
    case 500: g = bmi323.eGyroRange500DPS; break;
    case 1000: g = bmi323.eGyroRange1000DPS; break;
    case 2000: g = bmi323.eGyroRange2000DPS; break;
    default: return false;
  }
  const bool accelOk = bmi323.configAccel(bmi323.eAccelODR6400Hz, a, bmi323.eAccelModeHighPerf);
  const bool gyroOk = bmi323.configGyro(bmi323.eGyroODR6400Hz, g, bmi323.eGyroModeHighPerf);
  return accelOk && gyroOk;
}

// Called by the sole serial reader. I2C work belongs to the I2C task.
bool handleSensorCommand(const char *line) {
  if (strncmp(line, "RANGE", 5)) return false;
  int accel = 0, gyro = 0, end = 0;
  if (sscanf(line, "RANGE %d %d %n", &accel, &gyro, &end) != 2 || line[end] ||
      !(accel == 2 || accel == 4 || accel == 8 || accel == 16) ||
      !(gyro == 125 || gyro == 250 || gyro == 500 || gyro == 1000 || gyro == 2000)) {
    queueControlMessage("Sensor error: invalid ranges"); return true;
  }
  RangeRequest request = {accel, gyro};
  if (!rangeQueue || xQueueSend(rangeQueue, &request, 0) != pdPASS) queueControlMessage("Sensor error: range request queue unavailable");
  return true;
}

void i2cTask(void *) {
  SensorState state;
  uint32_t lastRetry = millis();
  uint32_t cycles = 0;
  for (;;) {
    if (uint32_t(millis() - lastRetry) >= 1000) {
      if (!bmiReady) bmiReady = bmi323.begin() && configureRanges(state.accelRange, state.gyroRange);
      if (!magReady && bmm350.begin() == 0) {
        magReady = true;
        bmm350.setOperationMode(eBmm350NormalMode);
        bmm350.setPresetMode(BMM350_PRESETMODE_LOWPOWER, BMM350_DATA_RATE_400HZ);
        bmm350.setMeasurementXYZ();
      }
      lastRetry = millis();
    }
    RangeRequest request;
    if (xQueueReceive(rangeQueue, &request, 0) == pdPASS) {
      const int oldAccel = state.accelRange, oldGyro = state.gyroRange;
      if (bmiReady && configureRanges(request.accel, request.gyro)) {
        state.accelRange = request.accel; state.gyroRange = request.gyro; state.rangeFailed = false;
      } else {
        state.rangeFailed = true;
        bmiReady = bmiReady && configureRanges(oldAccel, oldGyro);
      }
    }
    state.bmiValid = bmiReady && bmi323.getAccelGyroData(&state.accel, &state.gyro);
    if (state.bmiValid) ++state.bmiReads;
    state.magValid = magReady;
    if (magReady) { state.mag = bmm350.getGeomagneticData(); ++state.magReads; }
    portENTER_CRITICAL(&sensorMux); sensors = state; portEXIT_CRITICAL(&sensorMux);
    // Transfers wait on I2C interrupts. Also periodically let the idle task run.
    if ((++cycles & 31) == 0 || (!bmiReady && !magReady)) vTaskDelay(1);
  }
}

void printXYZ(const char *label, float x, float y, float z) {
  Serial.printf("%s%.3f, %.3f, %.3f\n", label, x, y, z);
}
void setup() {
  Serial.begin(115200); Serial.setTxTimeoutMs(20);
  const uint32_t started = millis();
  while (!Serial && millis() - started < 3000) delay(10);
  Serial.println("Antenna tracker: binary ADC acquisition v1");
  const gpio_num_t inputs[] = {GPIO_NUM_46, GPIO_NUM_4, GPIO_NUM_13, GPIO_NUM_14};
  for (auto pin : inputs) { gpio_set_direction(pin, GPIO_MODE_INPUT); gpio_set_pull_mode(pin, GPIO_FLOATING); }
  initServoOutputs();
  Wire.begin(A4, A5); Wire.setClock(400000); Wire.setTimeOut(50);
  // Complete sensor reset/configuration before starting the fast ADC timer.
  bmiReady = bmi323.begin() && configureRanges(ACCEL_RANGE_G, GYRO_RANGE_DPS);
  magReady = bmm350.begin() == 0;
  if (magReady) {
    bmm350.setOperationMode(eBmm350NormalMode);
    bmm350.setPresetMode(BMM350_PRESETMODE_LOWPOWER, BMM350_DATA_RATE_400HZ);
    bmm350.setMeasurementXYZ();
  }
  rangeQueue = xQueueCreate(4, sizeof(RangeRequest));
  if (!rangeQueue || xTaskCreatePinnedToCore(i2cTask, "i2c-sensors", 8192, nullptr, 2, nullptr, 0) != pdPASS)
    Serial.println("Sensor error: failed to start I2C acquisition");
  if (!startAdcAcquisition()) Serial.println("ADC acquisition failed: check rate/configuration");
  if (!startControlReceiver()) Serial.println("Servo error: failed to start command receiver");
}
void serviceTelemetry() {
  const bool controlReply = printControlMessages();
  sendAdcBatches();
  static uint32_t lastTelemetry = 0, lastScans = 0, lastBmi = 0, lastMag = 0;
  const uint32_t now = millis(), elapsed = now - lastTelemetry;
  if (elapsed && (controlReply || elapsed >= 1000 / TELEMETRY_HZ)) {
    SensorState state;
    portENTER_CRITICAL(&sensorMux); state = sensors; portEXIT_CRITICAL(&sensorMux);
    const auto adc = acquisitionStats();
    Serial.printf("Time ms: %lu\n", (unsigned long)now);
    const int diagnostic = adcDiagnosticChannel();
    Serial.printf("ADC mode: CHANNEL=%d SPI=%lu QUIET=%lu\n", diagnostic,
      (unsigned long)(diagnostic < 0 ? ADC_SPI_HZ : ADC_DIAGNOSTIC_SPI_HZ),
      (unsigned long)ADC_QUIET_US);
    Serial.printf("Rates: ADC=%.1f BMI=%.1f MAG=%.1f MISSED=%lu DROPS=%lu INVALID=%lu MAXSCAN=%lu\n",
      (adc.scans - lastScans) * 1000.0 / elapsed, (state.bmiReads - lastBmi) * 1000.0 / elapsed,
      (state.magReads - lastMag) * 1000.0 / elapsed, (unsigned long)adc.missedTicks,
      (unsigned long)adc.ringDrops, (unsigned long)adc.invalidScans, (unsigned long)adc.maxScanUs);
    Serial.printf("Ranges: ACCEL=%d GYRO=%d MAG=%d READY=%d\n", state.accelRange, state.gyroRange, MAG_RANGE_UT, state.bmiValid);
    Serial.printf("GPIO states: GPIO46=%d GPIO4=%d GPIO13=%d GPIO14=%d\n",
      gpio_get_level(GPIO_NUM_46), gpio_get_level(GPIO_NUM_4), gpio_get_level(GPIO_NUM_13), gpio_get_level(GPIO_NUM_14));
    printServoStates();
    if (state.bmiValid) {
      printXYZ("Accel g (x,y,z): ", state.accel.x, state.accel.y, state.accel.z);
      printXYZ("Gyro dps (x,y,z): ", state.gyro.x, state.gyro.y, state.gyro.z);
    } else Serial.println("BMI323 unavailable");
    if (state.magValid) printXYZ("Mag uT (x,y,z): ", state.mag.float_x, state.mag.float_y, state.mag.float_z);
    else Serial.println("BMM350 unavailable");
    if (state.rangeFailed) Serial.println("Sensor error: range change failed");
    Serial.println();
    lastTelemetry = now; lastScans = adc.scans; lastBmi = state.bmiReads; lastMag = state.magReads;
  }
  delay(1);
}

void writerTask(void *) {
  for (;;) serviceTelemetry();
}

void loop() {
  static bool started = false;
  if (!started) {
    started = xTaskCreatePinnedToCore(writerTask, "usb-writer", 6144, nullptr, 1, nullptr, 0) == pdPASS;
  }
  delay(100);
}
