#pragma once
#include <cstdint>
#include <cstring>
#include <string>
extern uint32_t fakeMillis;
inline uint32_t millis() { return fakeMillis; }
class Print {
public:
  virtual ~Print() = default;
  virtual size_t write(uint8_t) = 0;
  virtual size_t write(const uint8_t *data, size_t size) {
    for (size_t i = 0; i < size; ++i) write(data[i]);
    return size;
  }
};
class Stream : public Print {
public:
  virtual void flush() {}
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
};
struct FakeSerial {
  template<typename... Args> void printf(const char *, Args...) {}
  void println(const char *) {}
};
inline FakeSerial Serial;
