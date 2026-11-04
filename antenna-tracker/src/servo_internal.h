#pragma once
#include <Arduino.h>
#include <driver/ledc.h>
#include <driver/mcpwm.h>
#include "servo_config.h"
#include "servo_control.h"
#include "servo_feedback.h"
#include "tilt_imu.h"
#include "servo_motion_config.h"
#include "servo_motion_math.h"
#include "tilt_calibration.h"
#include "servo_feedback_filter.h"
#include "continuous_speed_control.h"
#include "position_pid.h"
#include "pan_calibration.h"
#include "track_geo.h"
#include <esp_timer.h>

namespace servo_internal {

struct ControlMessage { char text[96]; };

extern PanCalibration panCalibration;
extern QueueHandle_t messages;
extern portMUX_TYPE servoMux;
extern bool ready[3], enabled[3], manualDirect[3];
extern bool armed, estopLatched;
extern ServoControlHealth controlHealth;
extern TiltSweep tiltSweep;

struct PwmSweep {
  bool active = false;
  float startUs = 0, endUs = 0, rateUsPerSec = 0, currentUs = 0;
};
extern PwmSweep pwmSweep[3];
extern float pwmSlewVelocityUsPerSec[3];
extern ServoPotFilter tiltPotFilter;
extern ServoVelocityWindow tiltVelocityWindow;
extern ConsecutiveFeedbackFault overspeedConfirmation[2];
extern uint64_t invalidVelocityStartedUs[2];
extern uint64_t lastValidTiltPotUs;
extern ServoVelocityPotFilter tiltVelocityPotFilter;
extern float savedSweepSpeedLimit;
extern uint32_t pulseUs[3], frequencyHz[3];
extern float actualTiltPulseUs;
extern uint32_t targetPulseUs[3];
extern float rampPulseUs[3], measuredDegrees[2], measuredSpeed[2];
extern float filteredDegrees[2];
extern uint64_t lastFeedbackUs[2], lastMotionUs;
extern float trajectoryVelocity[2];
extern uint64_t trackingFaultStartedUs[2];
extern float continuousDemandSpeed[2];
extern ContinuousSpeedControl speedControl[2];
extern PositionPid positionPid[2];
extern bool positionActive[2];
extern float positionTarget[2], positionSetpoint[2];
struct PositionBreakaway {
  bool active = false;
  int sign = 0;
  uint64_t startedUs = 0;
  uint64_t endedUs = 0;
  uint64_t maxUs = 0;
  float offsetUs = 0;
  float startAngle = NAN;
};
extern PositionBreakaway positionBreakaway[2];
extern int tiltImuAxis;
extern bool tiltImuMappingReady;
extern float tiltImuZero;
extern unsigned tiltImuMappedMinPulse, tiltImuMappedMaxPulse;
extern float tiltImuMinPulseAngle, tiltImuMaxPulseAngle;
extern float previousFeedbackAngle[2];

bool usesImu(int i);
bool imuFresh(const TiltImuSample &s, uint64_t now);
bool continuous(int i);
unsigned neutralPulse(int i);
int continuousDirection(int i);
float continuousFeedforward(int i);
float speedLimit(int i);
float minAngle(int i);
float maxAngle(int i);
float positionLowerAngle(int i);
float positionUpperAngle(int i);
float angularPositionPulse(int i, float relativeAngle);
float feedbackAngle(const ServoFeedback &fb, int i);
bool feedbackFresh(const ServoFeedback &fb, int i, uint64_t now);
bool applyPulse(int i, float pulse);
bool validConfig(const ServoConfig &c);
void stopOutput(int i);
void acknowledge(int i);
void safetyState();
bool safetyCommand(const char *line);
void command(const char *line);
bool savePanSettings();
void loadPanSettings();
bool saveTrackHome();
void loadTrackHome();
// Arm continuous/limited position loop for one axis (Tune SERVO POSITION + TRACK TARGET).
bool applyPositionTarget(int i, float target, const char **error);
bool applyTrackLatLonAlt(float lat, float lon, float alt, const char **error);
void updateTrackPredictMotion(uint64_t nowUs);

extern TrackHome trackHome;

}  // namespace servo_internal
