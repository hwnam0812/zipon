// Minimal host-only test doubles. Not shipped to a board or in the hardware ZIP.
#pragma once
#include <cstdint>
#include <sstream>
#include <string>
#include <type_traits>
class __FlashStringHelper;
#define F(s) reinterpret_cast<const __FlashStringHelper *>(s)
constexpr int HIGH=1, LOW=0, OUTPUT=1, INPUT=0, DEFAULT=0, A5=19;
inline uint32_t fakeNow=0;
inline int fakeAdc=100, pins[32]={0};
inline uint8_t PINB=0, PCICR=0, PCMSK0=0;
constexpr int PB3=3, PCIE0=0, PCINT3=3;
#define _BV(n) (1U << (n))
inline uint32_t millis() { return fakeNow; }
inline uint32_t micros() { return fakeNow * 1000U; }
inline void pinMode(int, int) {}
inline void digitalWrite(int p, int value) { pins[p]=value; }
inline int analogRead(int) { return fakeAdc; }
inline void analogReference(int) {}
inline void delayMicroseconds(int) {}
inline void tone(int p, int) { pins[p]=HIGH; }
inline void noTone(int p) { pins[p]=LOW; }
class Print {
public:
  virtual ~Print() = default;
  virtual size_t write(uint8_t value)=0;
  void print(const __FlashStringHelper *s) { print(reinterpret_cast<const char *>(s)); }
  void print(const char *s) { while (*s) write(static_cast<uint8_t>(*s++)); }
  void print(char *s) { print(static_cast<const char *>(s)); }
  void print(char c) { write(static_cast<uint8_t>(c)); }
  void print(uint8_t v) { print(static_cast<unsigned>(v)); }
  template<class T> void print(T v) { const std::string s=std::to_string(v); print(s.c_str()); }
  template<class T> void println(T v) { print(v); print('\n'); }
};
inline int fakeTxCapacity=1000000;
struct SerialStub : public Print {
  std::ostringstream output;
  std::string input;
  void begin(int) {}
  int available() { return static_cast<int>(input.size()); }
  int availableForWrite() { return fakeTxCapacity; }
  size_t write(uint8_t value) override { if (!fakeTxCapacity) return 0; if (fakeTxCapacity<1000000) --fakeTxCapacity; output << static_cast<char>(value); return 1; }
  char read() { char c=input.front(); input.erase(0,1); return c; }
  void print(const __FlashStringHelper *s) { output << reinterpret_cast<const char *>(s); }
  void print(uint8_t v) { output << static_cast<unsigned>(v); }
  template<class T> void print(T v) { output << v; }
  template<class T> void println(T v) { print(v); output << '\n'; }
  void clear() { output.str(""); output.clear(); }
};
inline SerialStub Serial;
