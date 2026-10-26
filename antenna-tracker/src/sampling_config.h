#pragma once
#include <stdint.h>

// Target retained readings per channel per second, applied at startup.
// Rebuild/upload after editing. Range: >0 through 10000 Hz.
extern float adcSampleHz;

constexpr float ADC_SAMPLE_HZ = 1000.0f;       // Full scan of all 16 channels
// ADS7953 silicon limit: 1,000,000 conversions/s TOTAL across its multiplexer,
// not per channel. All 16 channels with no discards: 62,500 readings/channel/s.
// Retained limit with N consecutive and D discarded: 62,500 * (N-D)/N;
// N=10,D=2 gives 50,000 retained readings/channel/s at the chip's rated limit.
// Our 16 MHz SPI + 1 us CS-high quiet time needs >=2 us/conversion, so its
// wire-time ceiling is 500,000 conversions/s, or 25,000 retained/channel/s
// with N=10,D=2. SPI calls, GPIO, scheduling and transport lower actual rates.
// The firmware currently accepts ADC_SAMPLE_HZ <=10,000; these are ceilings,
// not supported settings or a measured throughput guarantee.
// TI reference: https://www.ti.com/product/ADS7953
// Consecutive conversions per channel before advancing (1..64).
// Each channel gets this many total conversions per burst. Larger counts
// increase burst time and may require lowering ADC_SAMPLE_HZ.
constexpr uint32_t ADC_CONSECUTIVE_READINGS = 10;
static_assert(ADC_CONSECUTIVE_READINGS >= 1 && ADC_CONSECUTIVE_READINGS <= 64,
              "ADC_CONSECUTIVE_READINGS must be 1..64");
// Discard this many initial conversions on EACH channel for settling.
// 0 keeps/sends every conversion; N-1 keeps only the last of N conversions.
constexpr uint32_t ADC_DISCARDED_READINGS = 2;
static_assert(ADC_DISCARDED_READINGS < ADC_CONSECUTIVE_READINGS,
              "Keep at least one reading: discarded must be less than consecutive");
constexpr uint32_t ADC_SPI_HZ = 16000000; // <=20 MHz per TI; reduce for wiring diagnostics.
// Keep diagnostic and scanning clocks equal for a meaningful noise comparison.
// Set both to 1000000 for a slow-clock wiring/settling check, then rebuild/upload.
constexpr uint32_t ADC_DIAGNOSTIC_SPI_HZ = ADC_SPI_HZ;
// CS-high recovery time between conversions. Increase to 2..5 us to check
// multiplexer/buffer settling; slower SPI or longer delays reduce throughput.
constexpr uint32_t ADC_QUIET_US = 1;
static_assert(ADC_SPI_HZ > 0 && ADC_SPI_HZ <= 20000000 &&
              ADC_DIAGNOSTIC_SPI_HZ > 0 && ADC_DIAGNOSTIC_SPI_HZ <= 20000000,
              "ADC SPI clocks must be >0 and <=20 MHz");
static_assert(ADC_QUIET_US >= 1 && ADC_QUIET_US <= 100,
              "ADC quiet time must be 1..100 us");
constexpr uint32_t TELEMETRY_HZ = 20; // I2C/GPIO/PWM status; ADC batches are independent.
constexpr uint32_t CHIP_TEMPERATURE_HZ = 5; // ESP32-S3 internal temperature, not ambient.
