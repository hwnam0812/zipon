// UNO standalone check. Small passive PIEZO only, not a magnetic buzzer.
// HC-SR04: Trig D9, Echo D8. LED: D7 through its own 330 ohm resistor.
// Piezo: D6 through a separate 330 ohm resistor to +; - to GND.
// No external capacitor, gas sensing or app connection.
#include <Arduino.h>

const uint8_t TRIG = 9;
const uint8_t ECHO = 8;
const uint8_t LED = 7;
const uint8_t BUZZER = 6;
bool ledOn = false;

void setup() {
  Serial.begin(9600);
  digitalWrite(TRIG, LOW);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  digitalWrite(LED, LOW);
  pinMode(LED, OUTPUT);
  digitalWrite(BUZZER, LOW);
  pinMode(BUZZER, OUTPUT);

  // One short startup test. Finish before measuring the first echo.
  Serial.println(F("BUZZER TEST: D6, 2000 Hz, 200 ms"));
  tone(BUZZER, 2000, 200);
  delay(250);
  noTone(BUZZER);
  digitalWrite(BUZZER, LOW);
}

void loop() {
  ledOn = !ledOn;
  digitalWrite(LED, ledOn ? HIGH : LOW);

  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);

  const unsigned long duration = pulseIn(ECHO, HIGH, 30000UL);
  Serial.print(F("LED: "));
  Serial.print(ledOn ? F("ON") : F("OFF"));
  if (duration == 0) {
    Serial.println(F(" | NO ECHO"));
  } else {
    const float distance = duration * 0.017f;
    Serial.print(F(" | Distance: "));
    Serial.print(distance, 1);
    Serial.println(F(" cm"));
  }
  delay(1000);
}
