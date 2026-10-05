#pragma once
#include <stdint.h>

// Target retained readings per channel per second, applied at startup.
// Rebuild/upload after editing. Range: >0 through 10000 Hz.
extern float adcSampleHz;

constexpr float ADC_SAMPLE_HZ = 10000.0f;       // Full scan of all 16 channels
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
