// Diagnostic ONLY. Latest user wiring: Trig -> D7, Echo -> D11.
// Earlier visual inference of D8/D9 was incorrect and has been withdrawn.
// Keep the user's wiring. This is NOT the app firmware.
// No gas sensing, networking, commands, LED indication or buzzer activation.
// VCC -> UNO 5V directly; 220uF parallel across VCC(+) and GND(-), NOT in series.
#include <Arduino.h>
#if !defined(__AVR_ATmega328P__)
#error "Select Arduino Uno (ATmega328P)."
#endif

const uint8_t TRIG_PIN = 7;
const uint8_t ECHO_PIN = 11;
const uint8_t BUZZER_PIN = 6;

void setup() {
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(8, LOW);
  pinMode(8, OUTPUT);  // Keep the separate status LED off during this check.
  digitalWrite(TRIG_PIN, LOW);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.begin(115200);
  Serial.println(F("CHECK ONLY: TRIG=D7 ECHO=D11; no app connection"));
  delay(1000);
}

void loop() {
  // Bound the wait. A timeout is NOT a distance of zero or an open door.
  if (digitalRead(ECHO_PIN) == HIGH) {
    Serial.println(F("ECHO_HIGH_BEFORE_TRIGGER: check signal/power"));
    delay(500);
    return;
  }
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  const unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (us == 0) {
    Serial.println(F("NO_ECHO: no complete echo pulse; distance unknown"));
  } else {
    const float cm = us * 0.0343f / 2.0f;
    Serial.print(F("pulse_us=")); Serial.print(us);
    Serial.print(F(" distance_cm=")); Serial.print(cm, 1);
    if (cm < 2.0f || cm > 400.0f) Serial.print(F(" OUT_OF_RANGE: do not use as door state"));
    Serial.println();
  }
  delay(500);
}
