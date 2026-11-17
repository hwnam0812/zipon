// Zipon practice monitor, NOT a certified gas/fire/safety alarm.
// UNO R3 only. LED D8, small PASSIVE piezo D6, Trig D9, Echo D11, MQ135 AO A5.
// No password/key in this sketch. Local settings are RAM-only; gas starts OFF.
#include <Arduino.h>
#include <avr/interrupt.h>
#include <util/atomic.h>
#include <string.h>
#include <stdlib.h>
#if !defined(__AVR_ATmega328P__)
#error "Select Arduino Uno (ATmega328P)."
#endif

const uint8_t LED_PIN = 8, BUZZER_PIN = 6, TRIG_PIN = 9, ECHO_PIN = 11;
struct Config {
  uint16_t closedMm, toleranceMm, doorHoldMs;
  bool doorCalibrated, doorSignals, gasEnabled;
  uint16_t baselineAdc, riseAdc;
  uint32_t gasHoldMs;
};
Config cfg = {120, 80, 1000, false, true, false, 0, 100, 10000};
char session[33] = "", revision[17] = "0000000000000000";
char line[192], recentIds[4][37] = {{0}};
uint8_t used = 0, recentSlot = 0;
bool discardLine = false;
uint32_t lastPing = 0, sequence = 0, eventSequence = 0;
uint32_t manualAt[2] = {0}, manualMs[2] = {0};
uint32_t offAt[2] = {0}, offMs[2] = {0}, muteAt = 0, muteMs = 0;
uint32_t doorPulseAt = 0;
bool doorPulse = false, ledOn = false, buzzerOn = false;
char ledSource = 'N', buzzerSource = 'N';
char doorState = 'U', doorCandidate = 'U', doorBaseline = 'U';
uint32_t doorSince = 0, gasSince = 0;
bool gasTiming = false, gasAlarm = false;
uint8_t gasStatus = 0; // 0 disabled, 1 below, 2 watching, 3 alert, 4 fault
int gasAdc = -1;
uint32_t gasSum = 0;
uint16_t gasCount = 0;
uint32_t lastGas = 0, lastAverage = 0, lastReport = 0, lastTrigger = 0;
long distanceMm = -1;
uint32_t distanceAt = 0;
volatile uint8_t echoPhase = 0;
volatile uint32_t echoRise = 0, echoWidth = 0;
volatile bool echoReady = false;

uint32_t remaining(uint32_t now, uint32_t start, uint32_t duration) {
  uint32_t elapsed = now - start;
  return duration && elapsed < duration ? duration - elapsed : 0;
}
uint16_t secondsLeft(uint32_t ms) { return (ms + 999UL) / 1000UL; }
bool validHex(const char *s, uint8_t length, bool uuid = false) {
  if (!s || strlen(s) != length) return false;
  for (uint8_t i = 0; i < length; i++) {
    if (uuid && (i == 8 || i == 13 || i == 18 || i == 23)) { if (s[i] != '-') return false; }
    else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  }
  return true;
}
bool numberToken(char *s, uint32_t min, uint32_t max, uint32_t &value) {
  if (!s || !*s || strlen(s) > 8) return false;
  for (char *p = s; *p; p++) if (*p < '0' || *p > '9') return false;
  value = strtoul(s, NULL, 10);
  return value >= min && value <= max;
}
void ack(const char *id, bool accepted) {
  Serial.print(F("ACK ")); Serial.print(session); Serial.print(' '); Serial.print(id);
  Serial.println(accepted ? F(" APPLIED") : F(" REJECTED"));
}
void event(const __FlashStringHelper *kind, uint32_t now) {
  if (!session[0]) return; // No offline history/clock is promised.
  Serial.print(F("E ")); Serial.print(session); Serial.print(' '); Serial.print(++eventSequence);
  Serial.print(' '); Serial.print(now); Serial.print(' '); Serial.print(kind);
  Serial.print(' '); Serial.print(gasAdc); Serial.print(' '); Serial.println(distanceMm);
}
void clearManual() { manualMs[0] = manualMs[1] = 0; }

void evaluateDoor(long mm, uint32_t now) {
  if (!cfg.doorCalibrated || mm < 20 || mm > 4000) {
    doorState = doorCandidate = doorBaseline = 'U'; return;
  }
  char candidate = labs(mm - cfg.closedMm) > cfg.toleranceMm ? 'O' : 'C';
  if (candidate != doorCandidate) { doorCandidate = candidate; doorSince = now; return; }
  if ((uint32_t)(now - doorSince) < cfg.doorHoldMs || candidate == doorState) return;
  doorState = candidate;
  // The first confirmed reading (also after a failed echo) is a baseline.
  if (doorBaseline != 'U' && doorBaseline != candidate) {
    event(candidate == 'O' ? F("DOOR_OPEN") : F("DOOR_CLOSED"), now);
    if (cfg.doorSignals) { doorPulse = true; doorPulseAt = now; }
  }
  doorBaseline = candidate;
}
void evaluateGas(int adc, uint32_t now) {
  if (!cfg.gasEnabled) { gasStatus = 0; gasTiming = false; return; }
  // Missing/zero never clears an existing warning. Saturation 1023 remains high.
  if (adc <= 0) { gasStatus = 4; gasTiming = false; return; }
  uint16_t threshold = cfg.baselineAdc + cfg.riseAdc;
  uint16_t recovery = cfg.baselineAdc + cfg.riseAdc / 2;
  bool timing = gasAlarm ? adc < recovery : adc >= threshold;
  if (!timing) { gasTiming = false; gasStatus = gasAlarm ? 3 : 1; return; }
  if (!gasTiming) { gasTiming = true; gasSince = now; }
  gasStatus = gasAlarm ? 3 : 2;
  if ((uint32_t)(now - gasSince) < cfg.gasHoldMs) return;
  gasAlarm = !gasAlarm; gasTiming = false; gasStatus = gasAlarm ? 3 : 1;
  event(gasAlarm ? F("GAS_ALERT") : F("GAS_BELOW"), now);
}
void updateOutputs(uint32_t now) {
  if ((uint32_t)(now - lastPing) >= 3000UL) clearManual();
  if (doorPulse && (uint32_t)(now - doorPulseAt) >= 500UL) doorPulse = false;
  bool outputs[2] = {false, false};
  char sources[2] = {'N', 'N'};
  for (uint8_t i = 0; i < 2; i++) {
    if (remaining(now, offAt[i], offMs[i])) { sources[i] = 'P'; continue; }
    if (remaining(now, manualAt[i], manualMs[i])) { outputs[i] = true; sources[i] = 'M'; }
    else if (cfg.gasEnabled && gasAlarm) {
      sources[i] = 'G'; outputs[i] = (now / (i ? 1000UL : 400UL)) % 2 == 0;
    } else if (doorPulse) {
      sources[i] = 'D'; outputs[i] = i == 0 || (uint32_t)(now - doorPulseAt) < 200UL;
    }
    // Sound pause affects automatic reactions only; manual tests stay explicit.
    if (i == 1 && sources[i] != 'M' && remaining(now, muteAt, muteMs)) { sources[i] = 'P'; outputs[i] = false; }
  }
  ledOn = outputs[0]; ledSource = sources[0]; digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
  if (outputs[1] != buzzerOn) {
    buzzerOn = outputs[1];
    if (buzzerOn) tone(BUZZER_PIN, 2000);
    else { noTone(BUZZER_PIN); digitalWrite(BUZZER_PIN, LOW); }
  }
  buzzerSource = sources[1];
}
void processLine() {
  char *save, *op = strtok_r(line, " ", &save);
  if (!op) return;
  // Emergency software cancellation of MANUAL outputs, not automatic sensing.
  if (!strcmp(op, "MANUAL_OFF")) { clearManual(); return; }
  char *sid = strtok_r(NULL, " ", &save);
  if (!strcmp(op, "HELLO")) {
    if (!validHex(sid, 32) || strtok_r(NULL, " ", &save)) return;
    if (strcmp(sid, session)) {
      clearManual(); strcpy(session, sid); sequence = eventSequence = 0;
      memset(recentIds, 0, sizeof(recentIds));
      cfg.gasEnabled = false; cfg.doorCalibrated = false;
      strcpy(revision, "0000000000000000");
      doorState = doorCandidate = doorBaseline = 'U';
      offMs[0] = offMs[1] = muteMs = 0; doorPulse = false;
    }
    lastPing = millis();
    Serial.print(F("READY ")); Serial.print(session); Serial.println(F(" ZIPON_AUTO_V3")); return;
  }
  if (!session[0] || !sid || strcmp(sid, session)) return;
  if (!strcmp(op, "PING")) { if (!strtok_r(NULL, " ", &save)) lastPing = millis(); return; }
  if (!strcmp(op, "CFG")) {
    char *rev = strtok_r(NULL, " ", &save);
    uint32_t v[10];
    const uint32_t mins[10] = {20,20,1000,0,0,0,0,1,5000,0};
    const uint32_t maxs[10] = {3900,1000,5000,1,1,1,1022,1022,60000,0};
    // Nine numeric fields: closed, tolerance, hold, calibrated, signals,
    // gasEnabled, baseline, rise, gasHold. No unparsed trailing arguments.
    if (!validHex(rev, 16)) return;
    for (uint8_t i = 0; i < 9; i++) if (!numberToken(strtok_r(NULL, " ", &save), mins[i], maxs[i], v[i])) return;
    if (strtok_r(NULL, " ", &save) || (uint32_t)(millis() - lastPing) >= 3000UL || (v[5] && (!v[6] || v[6] + v[7] > 1023))) return;
    if (strcmp(rev, revision)) {
      bool doorChanged = cfg.closedMm != v[0] || cfg.toleranceMm != v[1] || cfg.doorHoldMs != v[2] || cfg.doorCalibrated != (bool)v[3];
      cfg = {(uint16_t)v[0],(uint16_t)v[1],(uint16_t)v[2],(bool)v[3],(bool)v[4],(bool)v[5],(uint16_t)v[6],(uint16_t)v[7],v[8]};
      strcpy(revision, rev); gasTiming = false;
      if (doorChanged) { doorState = doorCandidate = doorBaseline = 'U'; doorPulse = false; }
      evaluateGas(gasAdc, millis());
    }
    return;
  }
  if (strcmp(op, "SET")) return;
  char *id = strtok_r(NULL, " ", &save), *target = strtok_r(NULL, " ", &save), *action = strtok_r(NULL, " ", &save);
  uint32_t seconds;
  if (!validHex(id, 36, true) || !target || !action || !numberToken(strtok_r(NULL, " ", &save), 0, 60, seconds) || strtok_r(NULL, " ", &save)) return;
  for (uint8_t i = 0; i < 4; i++) if (!strcmp(id, recentIds[i])) { ack(id, true); return; }
  uint32_t now = millis();
  if ((uint32_t)(now - lastPing) >= 3000UL) { ack(id, false); return; }
  bool accepted = false;
  if (!strcmp(target, "A")) {
    if (!strcmp(action, "MUTE") && seconds == 60) { muteAt = now; muteMs = 60000; accepted = true; }
    if (!strcmp(action, "RESUME") && seconds == 0) { muteMs = 0; offMs[1] = 0; accepted = true; }
  } else if (!strcmp(target, "L") || !strcmp(target, "B")) {
    uint8_t i = target[0] == 'L' ? 0 : 1;
    if ((!strcmp(action, "ON") && seconds >= 1 && seconds <= 15) || (!strcmp(action, "TEST") && seconds == 2)) {
      manualAt[i] = now; manualMs[i] = seconds * 1000UL; offMs[i] = 0; accepted = true;
    }
    if (!strcmp(action, "OFF") && seconds == 30) { manualMs[i] = 0; offAt[i] = now; offMs[i] = 30000; accepted = true; }
  }
  if (accepted) { strcpy(recentIds[recentSlot], id); recentSlot = (recentSlot + 1) % 4; }
  updateOutputs(now); ack(id, accepted);
}

// UNO D11 = PB3 / PCINT3. Echo capture never waits in pulseIn().
ISR(PCINT0_vect) {
  bool high = PINB & _BV(PB3);
  if (echoPhase == 1 && high) { echoRise = micros(); echoPhase = 2; }
  else if (echoPhase == 2 && !high) { echoWidth = micros() - echoRise; echoReady = true; echoPhase = 0; }
}
void report(uint32_t now) {
  Serial.print(F("R ")); Serial.print(session); Serial.print(' '); Serial.print(++sequence);
  Serial.print(' '); Serial.print(now); Serial.print(' '); Serial.print(gasAdc);
  Serial.print(' '); Serial.print(distanceMm); Serial.print(' '); Serial.print(doorState);
  Serial.print(' '); Serial.print(gasStatus); Serial.print(' '); Serial.print(gasAlarm ? 1 : 0);
  Serial.print(' '); Serial.print(ledOn ? 1 : 0); Serial.print(' '); Serial.print(buzzerOn ? 1 : 0);
  Serial.print(' '); Serial.print(ledSource); Serial.print(' '); Serial.print(buzzerSource);
  Serial.print(' '); Serial.print(secondsLeft(remaining(now, muteAt, muteMs)));
  Serial.print(' '); Serial.print(secondsLeft(remaining(now, offAt[0], offMs[0])));
  Serial.print(' '); Serial.print(secondsLeft(remaining(now, offAt[1], offMs[1])));
  Serial.print(' '); Serial.println(revision);
}
void setup() {
  digitalWrite(BUZZER_PIN, LOW); pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW); pinMode(LED_PIN, OUTPUT);
  pinMode(10, INPUT); // Old dust LED circuit is removed.
  digitalWrite(TRIG_PIN, LOW); pinMode(TRIG_PIN, OUTPUT); pinMode(ECHO_PIN, INPUT);
  analogReference(DEFAULT); pinMode(A5, INPUT); analogRead(A5);
  PCICR |= _BV(PCIE0); PCMSK0 |= _BV(PCINT3);
  Serial.begin(115200); Serial.println(F("BOOT ZIPON_AUTO_V3"));
  lastGas = lastAverage = millis();
}
void loop() {
  uint32_t now = millis(); updateOutputs(now);
  for (uint8_t n = 0; n < 32 && Serial.available(); n++) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (!discardLine) { line[used] = 0; processLine(); }
      used = 0; discardLine = false;
    } else if (!discardLine) {
      if (used < sizeof(line) - 1 && c >= 32 && c <= 126) line[used++] = c;
      else { discardLine = true; used = 0; }
    }
  }
  now = millis();
  if ((uint32_t)(now - lastGas) >= 50UL) { lastGas = now; gasSum += analogRead(A5); gasCount++; }
  if ((uint32_t)(now - lastAverage) >= 1000UL) {
    bool continuous = (uint32_t)(now - lastAverage) < 2000UL;
    gasAdc = continuous && gasCount >= 10 ? (int)(gasSum / gasCount) : -1;
    if (!continuous) gasTiming = false;
    lastAverage = now; gasSum = gasCount = 0; evaluateGas(gasAdc, now);
  }
  bool ready; uint32_t width;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { ready = echoReady; width = echoWidth; echoReady = false; }
  if (ready) {
    long mm = (long)(width * 0.1715f);
    distanceMm = mm >= 20 && mm <= 4000 ? mm : -1;
    distanceAt = now; evaluateDoor(distanceMm, now);
  }
  if (echoPhase && (uint32_t)(now - lastTrigger) > 30UL) {
    ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { echoPhase = 0; }
    distanceMm = -1; evaluateDoor(-1, now);
  }
  if ((uint32_t)(now - distanceAt) >= 500UL) { distanceMm = -1; evaluateDoor(-1, now); }
  if ((uint32_t)(now - lastTrigger) >= 100UL) {
    lastTrigger = now;
    ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { echoReady = false; echoPhase = 1; }
    digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10); digitalWrite(TRIG_PIN, LOW);
  }
  updateOutputs(now);
  if (session[0] && (uint32_t)(now - lastReport) >= 2000UL) { lastReport = now; report(now); }
}
