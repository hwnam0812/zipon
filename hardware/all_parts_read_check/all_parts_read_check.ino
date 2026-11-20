// UNO USB-powered bench check; available power must be checked on the real setup.
// HC-SR04 Trig D9 / Echo D8; LED D7 through its own 330 ohm resistor.
// Small passive PIEZO D6 through a separate 330 ohm resistor; not magnetic.
// MQ-135 4-pin module: VCC 5V, GND common, AO A5, DO disconnected.
// Raw ADC only: no ppm, gas identification, safety judgment or gas alarm.
// No external capacitor, app connection or automatic gas-triggered outputs.
#include <Arduino.h>

const uint8_t TRIG = 9;
const uint8_t ECHO = 8;
const uint8_t LED = 7;
const uint8_t BUZZER = 6;
const uint8_t GAS = A5;
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
  pinMode(GAS, INPUT);
  analogReference(DEFAULT);

  tone(BUZZER, 2000, 200);
  delay(250);
  noTone(BUZZER);
  digitalWrite(BUZZER, LOW);
  Serial.println(F("RAW ADC ONLY - NOT ppm OR A SAFETY TEST"));
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
  const int gasRaw = analogRead(GAS);

  Serial.print(F("LED: "));
  Serial.print(ledOn ? F("ON") : F("OFF"));
  if (duration == 0) {
    Serial.print(F(" | NO ECHO"));
  } else {
    Serial.print(F(" | Distance: "));
    Serial.print(duration * 0.017f, 1);
    Serial.print(F(" cm"));
  }
  Serial.print(F(" | MQ135 ADC: "));
  Serial.print(gasRaw);
  if (gasRaw == 0 || gasRaw == 1023) {
    Serial.print(F(" [ADC LIMIT - CHECK WIRING/POWER]"));
  }
  Serial.println();
  delay(1000);
}
