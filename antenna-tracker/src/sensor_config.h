#pragma once
// Defaults applied at startup. Live web changes last until reset.
constexpr int ACCEL_RANGE_G = 8;       // 2, 4, 8, 16
constexpr int GYRO_RANGE_DPS = 2000;   // 125, 250, 500, 1000, 2000
constexpr int MAG_RANGE_UT = 2000;     // BMM350 fixed hardware range (not adjustable)
static_assert(ACCEL_RANGE_G == 2 || ACCEL_RANGE_G == 4 || ACCEL_RANGE_G == 8 || ACCEL_RANGE_G == 16, "Invalid acceleration range");
static_assert(GYRO_RANGE_DPS == 125 || GYRO_RANGE_DPS == 250 || GYRO_RANGE_DPS == 500 || GYRO_RANGE_DPS == 1000 || GYRO_RANGE_DPS == 2000, "Invalid gyro range");
static_assert(MAG_RANGE_UT == 2000, "BMM350 has a fixed range");
