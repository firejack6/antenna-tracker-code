#pragma once
void initServoOutputs();
void readServoCommands(bool reset = false);
void printServoStates();
void updateServoMotion(); // Called by the dedicated motion task at servoMotionIntervalUs.
void cancelServoMotion(); // Stop continuous outputs on connection loss.
bool startServoMotionTask(); // 200 Hz FreeRTOS task; call once after initServoOutputs.
void queueControlMessage(const char *message);
bool startControlReceiver();
bool printControlMessages();
struct ServoControlHealth { unsigned commands = 0, maxCommandUs = 0, maxUpdateUs = 0; };
ServoControlHealth servoControlHealth();
