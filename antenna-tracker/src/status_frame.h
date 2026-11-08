#pragma once
#include <stdint.h>

// Binary status sibling of ATB2: magic 00 41 54 53 31 ("ATS1"), u16 length, payload, u32 CRC32.
// Little-endian packed floats/ints. Relay maps fields into the same telemetry dict keys as text Parser.

#pragma pack(push, 1)
struct StatusServoAxis {
  int32_t gpio, pmin, pcenter, pmax, fmin, fcenter, fmax;
  int32_t pulse, freq, enable, ready, umin, ucenter, umax, mode, neutral, raw;
};
struct StatusMotionAxis {
  float angle, speed, limit, commandspeed, minangle, maxangle;
  float slew_rate, slew_accel;
  uint32_t target;
  int32_t moving, osfault;
};
struct StatusPidAxis {
  float setpoint, error, p, i, d, ff, startup, request, output;
  int32_t active, phase, mode;
};
struct StatusPositionAxis {
  float target, kp, ki, kd, ilimit, cap, tolerance, dbplus, dbminus, ramprate;
  int32_t active, ramp;
};
struct StatusFrame {
  uint32_t device_ms;
  int32_t adc_channel, adc_spi_hz, adc_quiet_us;
  float rate_adc, rate_bmi, rate_mag;
  uint32_t missed, drops, invalid, maxscan;
  uint32_t queued, capacity, stalls, failed, maxwrite, connections, pending, close_reason;
  uint32_t commands, cmdmax, ctrlmax;
  int32_t accel_range, gyro_range, mag_range, ranges_ready;
  int32_t gpio46, gpio4, gpio13, gpio14;
  int32_t armed, estop;
  StatusServoAxis servos[3];
  StatusMotionAxis motion[2];
  StatusPidAxis pid[2];
  StatusPositionAxis position[2];
  float pan_neutral, pan_polarity, pan_vmin, pan_vmax, pan_span, pan_zero, pan_amin, pan_amax;
  float tilt_vmin, tilt_vmax, tilt_zero, tilt_amin, tilt_amax, tilt_volts, tilt_smin, tilt_smax;
  float tilt_progress, tilt_cap, tilt_filtered, tilt_minpwm;
  int32_t tilt_sweep, tilt_reason, tilt_poldir, tilt_rotations, tilt_wrap;
  float imu_angle, imu_speed, imu_raw, imu_zero, imu_amin, imu_amax;
  int32_t imu_axis, imu_ready, imu_active;
  uint64_t imu_us;
  uint32_t imu_pmin, imu_pmax;
  float accel[3], gyro[3], mag[3];
  int32_t bmi_valid, mag_valid, range_failed;
  float chip_temp_c;
  uint64_t chip_temp_us;
  // Effective runtime config snapshot (change 7).
  float cfg_pan_speed, cfg_tilt_speed, cfg_pan_ramp_rate, cfg_tilt_ramp_rate;
  float cfg_pan_dbplus, cfg_pan_dbminus, cfg_tilt_dbplus, cfg_tilt_dbminus;
  float cfg_pan_kp, cfg_pan_ki, cfg_pan_kd, cfg_tilt_kp, cfg_tilt_ki, cfg_tilt_kd;
  int32_t cfg_pan_ramp, cfg_tilt_ramp, cfg_pan_osfault, cfg_tilt_osfault;
  float cfg_pan_ff, cfg_pan_rise, cfg_pan_fall, cfg_pan_search, cfg_pan_search_max, cfg_pan_brake;
  float cfg_pan_breakaway_us, cfg_pan_breakaway_ms;
  float cfg_pan_kp_near, cfg_pan_ki_near, cfg_pan_kd_near, cfg_pan_cap_near;
  float cfg_pan_schedule_deg, cfg_pan_brk_min_scale, cfg_pan_settle_deg;
  float cfg_adc_sample_hz;
  int32_t cfg_adc_stream; // 1 = ATB2 on TCP, 0 = lean (status only)
  int32_t cfg_wifi_ap;
  int32_t cfg_pan_fb; // PanPositionFeedback: 0=pot, 1=mag (2=fusion reserved)
};
#pragma pack(pop)

static_assert(sizeof(StatusFrame) == 972, "StatusFrame must match dashboard status_protocol.STATUS_SIZE");

bool sendStatusFrame(const StatusFrame &frame);
void fillServoStatus(StatusFrame &frame); // Safety, servos, motion, PID, position, calibrations, effective config.
