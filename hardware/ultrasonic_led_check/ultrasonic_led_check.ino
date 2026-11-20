// Standalone UNO check: HC-SR04 Trig D9, Echo D8; LED D7 through 330 ohm.
// No external capacitor, buzzer, gas sensing or app connection.
#include <Arduino.h>

const uint8_t TRIG_PIN = 9;
const uint8_t ECHO_PIN = 8;
const uint8_t LED_PIN = 7;
bool ledOn = false;

void setup() {
  Serial.begin(9600);
  digitalWrite(TRIG_PIN, LOW);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);
  Serial.println(F("ULTRASONIC_LED_CHECK: TRIG=9 ECHO=8 LED=7"));
}

void loop() {
  // Toggle once per reading, including failed readings. This is not an alarm.
  ledOn = !ledOn;
  digitalWrite(LED_PIN, ledOn ? HIGH : LOW);

  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  const unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  Serial.print(F("LED="));
  Serial.print(ledOn ? F("ON") : F("OFF"));
  Serial.print(F(" | "));
  if (duration == 0) {
    Serial.println(F("NO ECHO (distance unknown)"));
  } else {
    const float distance = duration * 0.017f;
    Serial.print(F("pulse_us="));
    Serial.print(duration);
    Serial.print(F(" | Distance: "));
    Serial.print(distance, 1);
    Serial.println(F(" cm"));
  }
  delay(1000);
}
