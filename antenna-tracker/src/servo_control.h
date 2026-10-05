#pragma once
void initServoOutputs();
void readServoCommands();
void printServoStates();
void queueControlMessage(const char *message);
bool startControlReceiver();
bool printControlMessages();
