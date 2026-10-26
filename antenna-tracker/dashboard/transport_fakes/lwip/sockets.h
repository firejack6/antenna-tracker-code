#pragma once
#include <cstddef>
constexpr int MSG_DONTWAIT = 1;
int send(int, const void *, size_t, int);
