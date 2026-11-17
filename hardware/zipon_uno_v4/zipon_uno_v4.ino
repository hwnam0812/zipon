// ZIPON USB V4 — practice only, NOT a certified gas/fire/security alarm.
// UNO R3: MQ-135 AO A5; HC-SR04 Trig D9, Echo D11; LED D8 + 330 ohm;
// SMALL PASSIVE piezo D6. Separate regulated MQ-135 5V, common GND.
// USB 9600, flat newline-delimited JSON. No credentials, heap Strings or JSON library.
#include <Arduino.h>
#include <avr/interrupt.h>
#include <util/atomic.h>
#include <string.h>
#include <stdlib.h>
#if !defined(__AVR_ATmega328P__)
#error "Select Arduino Uno (ATmega328P)"
#endif
const uint8_t LED_PIN=8, BUZZER_PIN=6, TRIG_PIN=9, ECHO_PIN=11;
const char PROTOCOL[]="ZIPON_USB_V4";
char inputLine[256], session[17]="";
uint16_t used=0; bool discard=false; uint32_t lastCommandId=0;
// Never block on a full 64-byte UART TX buffer: that would lose incoming JSON
// in the UNO's RX ring at 9600 baud. Reserve room before composing a whole line.
class QueuedSerial : public Print {
  char bytes[512]; uint16_t head=0, tail=0;
public:
  using Print::write;
  size_t write(uint8_t value) override {
    uint16_t next=(head+1)%sizeof(bytes);
    if (next==tail) return 0;
    bytes[head]=value; head=next; return 1;
  }
  uint16_t freeBytes() const { return (tail+sizeof(bytes)-head-1)%sizeof(bytes); }
  void pump() {
    while (tail!=head && Serial.availableForWrite()>0) { Serial.write((uint8_t)bytes[tail]); tail=(tail+1)%sizeof(bytes); }
  }
};
QueuedSerial tx;
struct Token { char *key; char *value; bool quoted; } tokens[14];
uint8_t tokenCount=0;
bool gasEnabled=false, gasAlarm=false, gasTiming=false, intrusionAlarm=false;
uint16_t thresholdAdc=300, recoveryAdc=250;
uint32_t gasHoldMs=10000, gasRecoveryMs=10000, gasSince=0, configRevision=0;
uint32_t lastPing=0, manualAt[2]={0}, manualMs[2]={0}, seq=0;
bool ledOn=false, buzzerOn=false; uint8_t ledSource=0, buzzerSource=0, gasState=0;
int gasRaw=-1; uint32_t gasSum=0, lastGas=0, lastAverage=0, lastReport=0;
uint16_t gasCount=0;
long distanceMm=-1; uint16_t distances[5]={0}; uint8_t distanceCount=0, distanceSlot=0;
uint32_t lastTrigger=0, distanceAt=0;
volatile uint8_t echoPhase=0; volatile uint32_t echoRise=0, echoWidth=0; volatile bool echoReady=false;

bool hexValue(const char *s, uint8_t length) {
  if (!s || strlen(s)!=length) return false;
  for (uint8_t i=0;i<length;i++) if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return false;
  return true;
}
char *spaces(char *p) { while (*p==' ' || *p=='\t') ++p; return p; }
// Strict flat JSON tokenizer. Reject duplicate keys, escapes, arrays, nested objects,
// signs/fractions, missing delimiters and trailing bytes. We only need unsigned ints.
bool parseJson() {
  tokenCount=0; char *p=spaces(inputLine);
  if (*p++!='{') return false;
  p=spaces(p); if (*p=='}') return false;
  while (*p && tokenCount<14) {
    if (*p++!='"') return false; char *key=p;
    while (*p && *p!='"') { if (*p<' ' || *p=='\\') return false; ++p; }
    if (!*p) return false; *p++=0;
    for (uint8_t i=0;i<tokenCount;i++) if (!strcmp(tokens[i].key,key)) return false;
    p=spaces(p); if (*p++!=':') return false; p=spaces(p);
    bool quoted=*p=='"'; if (quoted) ++p; char *value=p;
    if (quoted) {
      while (*p && *p!='"') { if (*p<' ' || *p=='\\') return false; ++p; }
      if (!*p) return false; *p++=0; p=spaces(p);
      char end=*p; if (end!=',' && end!='}') return false; ++p;
      tokens[tokenCount++]={key,value,true};
      if (end=='}') return !*spaces(p);
    } else {
      while (*p && *p!=',' && *p!='}' && *p!=' ' && *p!='\t') { if (*p=='{' || *p=='[' || *p=='"') return false; ++p; }
      char *endValue=p; p=spaces(p); char end=*p;
      if (!*value || (end!=',' && end!='}')) return false; ++p; *endValue=0;
      tokens[tokenCount++]={key,value,false};
      if (end=='}') return !*spaces(p);
    }
    p=spaces(p);
  }
  return false;
}
Token *get(const char *key) { for (uint8_t i=0;i<tokenCount;i++) if (!strcmp(tokens[i].key,key)) return &tokens[i]; return NULL; }
const char *text(const char *key) { Token *t=get(key); return t && t->quoted ? t->value : NULL; }
bool number(const char *key,uint32_t min,uint32_t max,uint32_t &out) {
  Token *t=get(key); if (!t || t->quoted || !*t->value || strlen(t->value)>10) return false;
  if (t->value[0]=='0' && t->value[1]) return false;
  uint32_t value=0;
  for (char *p=t->value;*p;p++) { if (*p<'0' || *p>'9') return false; uint8_t digit=*p-'0'; if (value>(0xffffffffUL-digit)/10UL) return false; value=value*10+digit; }
  if (value<min || value>max) return false; out=value; return true;
}
bool boolToken(const char *key,bool &out) { Token *t=get(key); if (!t || t->quoted) return false; if (!strcmp(t->value,"true")) { out=true; return true; } if (!strcmp(t->value,"false")) { out=false; return true; } return false; }
bool manual(uint8_t i,uint32_t now) { return manualMs[i] && (uint32_t)(now-manualAt[i])<manualMs[i]; }
void stopManual() { manualMs[0]=manualMs[1]=0; }
void outputs(uint32_t now) {
  if ((uint32_t)(now-lastPing)>=3000UL) { stopManual(); intrusionAlarm=false; }
  bool led=gasAlarm || manual(0,now), buzzer=gasAlarm || intrusionAlarm || manual(1,now);
  ledSource=gasAlarm?2:manual(0,now)?1:0;
  buzzerSource=gasAlarm?2:intrusionAlarm?3:manual(1,now)?1:0;
  ledOn=led; digitalWrite(LED_PIN,led?HIGH:LOW);
  if (buzzer!=buzzerOn) { buzzerOn=buzzer; if (buzzer) tone(BUZZER_PIN,2000); else { noTone(BUZZER_PIN); digitalWrite(BUZZER_PIN,LOW); } }
}
void evaluateGas(int adc,uint32_t now) {
  if (!gasEnabled) { gasState=0; gasTiming=false; return; }
  // Missing/zero NEVER clears an alarm. 1023 is a high saturated reading, not ppm.
  if (adc<=0) { gasState=4; gasTiming=false; return; }
  bool candidate=gasAlarm?adc<recoveryAdc:adc>=thresholdAdc;
  if (!candidate) { gasTiming=false; gasState=gasAlarm?3:1; return; }
  if (!gasTiming) { gasTiming=true; gasSince=now; }
  gasState=gasAlarm?3:2;
  if ((uint32_t)(now-gasSince)<(gasAlarm?gasRecoveryMs:gasHoldMs)) return;
  gasAlarm=!gasAlarm; gasTiming=false; gasState=gasAlarm?3:1;
}
void prefix(const __FlashStringHelper *type) {
  tx.print(F("{\"type\":\"")); tx.print(type); tx.print(F("\",\"protocol\":\"ZIPON_USB_V4\",\"session\":\"")); tx.print(session); tx.print('"');
}
void ack(const char *id,bool applied,const __FlashStringHelper *reason) {
  prefix(F("ack")); tx.print(F(",\"id\":\"")); tx.print(id); tx.print(F("\",\"applied\":")); tx.print(applied?F("true"):F("false")); tx.print(F(",\"reason\":\"")); tx.print(reason); tx.println(F("\"}"));
}
void processLine() {
  if (!parseJson()) return;
  const char *type=text("type"), *sid=text("session");
  if (!type || !hexValue(sid,16) || tx.freeBytes()<160) return;
  uint32_t now=millis();
  if (!strcmp(type,"hello")) {
    const char *p=text("protocol"); if (tokenCount!=3 || !p || strcmp(p,PROTOCOL)) return;
    if (strcmp(sid,session)) {
      strcpy(session,sid); stopManual(); intrusionAlarm=false; lastCommandId=0; seq=0;
      // Reconnecting cannot silence a live gas alarm while the board remains powered.
      if (!gasAlarm) { gasEnabled=false; gasTiming=false; gasState=0; configRevision=0; }
    }
    lastPing=now; prefix(F("ready")); tx.println('}'); return;
  }
  if (!session[0] || strcmp(sid,session)) return;
  if (!strcmp(type,"ping")) {
    bool alarm; if (tokenCount!=3 || !boolToken("intrusion",alarm)) return;
    lastPing=now; intrusionAlarm=alarm; return;
  }
  const char *id=text("id"); uint32_t validUntil;
  if (!hexValue(id,8) || !number("validUntil",0,0xffffffffUL,validUntil)) return;
  if ((uint32_t)(now-lastPing)>=3000UL || (int32_t)(validUntil-now)<=0 || (int32_t)(validUntil-now)>5000) { ack(id,false,F("expired")); return; }
  uint32_t commandId=strtoul(id,NULL,16);
  if (!commandId || commandId<lastCommandId) { ack(id,false,F("replay")); return; }
  if (commandId==lastCommandId) { ack(id,true,F("duplicate")); return; }
  bool accepted=false;
  if (!strcmp(type,"manual")) {
    const char *target=text("target"); bool on; uint32_t seconds;
    if (tokenCount!=7 || !target || (strcmp(target,"led") && strcmp(target,"buzzer")) || !boolToken("on",on) || !number("seconds",0,15,seconds) || (on && !seconds) || (!on && seconds)) { ack(id,false,F("invalid")); return; }
    uint8_t i=!strcmp(target,"led")?0:1;
    if (on) { manualAt[i]=now; manualMs[i]=seconds*1000UL; } else manualMs[i]=0;
    accepted=true;
  } else if (!strcmp(type,"config")) {
    uint32_t threshold,recovery,hold,recover,revision; bool enabled;
    if (tokenCount!=10 || !boolToken("gasEnabled",enabled) || !number("gasThreshold",1,1022,threshold) || !number("gasRecovery",1,1022,recovery) || recovery>=threshold || !number("gasHoldMs",5000,60000,hold) || !number("gasRecoveryMs",5000,60000,recover) || !number("rev",1,2147483647UL,revision)) { ack(id,false,F("invalid")); return; }
    if (gasAlarm) { ack(id,false,F("alarm_active")); return; }
    gasEnabled=enabled; thresholdAdc=threshold; recoveryAdc=recovery; gasHoldMs=hold; gasRecoveryMs=recover; configRevision=revision; gasTiming=false;
    evaluateGas(gasRaw,now); accepted=true;
  } else if (!strcmp(type,"intrusion")) {
    bool on; if (tokenCount!=5 || !boolToken("on",on)) { ack(id,false,F("invalid")); return; }
    intrusionAlarm=on; accepted=true;
  }
  if (accepted) { lastCommandId=commandId; outputs(now); }
  ack(id,accepted,accepted?F("applied"):F("invalid"));
}
ISR(PCINT0_vect) {
  bool high=PINB&_BV(PB3);
  if (echoPhase==1 && high) { echoRise=micros(); echoPhase=2; }
  else if (echoPhase==2 && !high) { echoWidth=micros()-echoRise; echoReady=true; echoPhase=0; }
}
void distanceReading(long mm,uint32_t now) {
  distanceAt=now;
  if (mm<20 || mm>4000) { distanceMm=-1; distanceCount=distanceSlot=0; return; }
  distances[distanceSlot]=(uint16_t)mm; distanceSlot=(distanceSlot+1)%5; if (distanceCount<5) distanceCount++;
  uint16_t sorted[5]; memcpy(sorted,distances,sizeof(sorted));
  for (uint8_t i=1;i<distanceCount;i++) { uint16_t value=sorted[i]; int8_t j=i-1; while (j>=0 && sorted[j]>value) { sorted[j+1]=sorted[j]; j--; } sorted[j+1]=value; }
  distanceMm=sorted[distanceCount/2];
}
void boolJson(bool value) { tx.print(value?F("true"):F("false")); }
void sourceJson(uint8_t source) { tx.print(source==2?F("gas"):source==3?F("intrusion"):source==1?F("manual"):F("off")); }
void report(uint32_t now) {
  if (tx.freeBytes()<480) return;
  prefix(F("telemetry")); tx.print(F(",\"seq\":")); tx.print(++seq); tx.print(F(",\"uptimeMs\":")); tx.print(now);
  tx.print(F(",\"gasRaw\":")); if (gasRaw<0) tx.print(F("null")); else tx.print(gasRaw);
  tx.print(F(",\"distanceCm\":")); if (distanceMm<0) tx.print(F("null")); else { tx.print(distanceMm/10); tx.print('.'); tx.print(distanceMm%10); }
  tx.print(F(",\"gasState\":\"")); tx.print(gasState==0?F("disabled"):gasState==1?F("below"):gasState==2?F("watch"):gasState==3?F("alert"):F("fault"));
  tx.print(F("\",\"gasAlarm\":")); boolJson(gasAlarm); tx.print(F(",\"intrusionAlarm\":")); boolJson(intrusionAlarm);
  tx.print(F(",\"led\":")); boolJson(ledOn); tx.print(F(",\"buzzer\":")); boolJson(buzzerOn);
  tx.print(F(",\"manualLed\":")); boolJson(manual(0,now)); tx.print(F(",\"manualBuzzer\":")); boolJson(manual(1,now));
  tx.print(F(",\"ledSource\":\"")); sourceJson(ledSource); tx.print(F("\",\"buzzerSource\":\"")); sourceJson(buzzerSource);
  tx.print(F("\",\"config\":")); tx.print(configRevision); tx.println('}');
}
void setup() {
  digitalWrite(LED_PIN,LOW); pinMode(LED_PIN,OUTPUT); digitalWrite(BUZZER_PIN,LOW); pinMode(BUZZER_PIN,OUTPUT);
  digitalWrite(TRIG_PIN,LOW); pinMode(TRIG_PIN,OUTPUT); pinMode(ECHO_PIN,INPUT); pinMode(10,INPUT);
  analogReference(DEFAULT); pinMode(A5,INPUT); analogRead(A5);
  PCICR|=_BV(PCIE0); PCMSK0|=_BV(PCINT3);
  Serial.begin(9600); tx.println(F("{\"type\":\"boot\",\"protocol\":\"ZIPON_USB_V4\"}")); tx.pump();
  lastGas=lastAverage=millis();
}
void loop() {
  uint32_t now=millis(); outputs(now); tx.pump();
  for (uint8_t n=0;n<64 && Serial.available();n++) {
    char c=Serial.read(); if (c=='\r') continue;
    if (c=='\n') { if (!discard) { inputLine[used]=0; processLine(); } used=0; discard=false; }
    else if (!discard) { if (used<sizeof(inputLine)-1 && c>=32 && c<=126) inputLine[used++]=c; else { used=0; discard=true; } }
  }
  now=millis();
  if ((uint32_t)(now-lastGas)>=50UL) { lastGas=now; gasSum+=analogRead(A5); gasCount++; }
  if ((uint32_t)(now-lastAverage)>=1000UL) {
    bool continuous=(uint32_t)(now-lastAverage)<2000UL;
    gasRaw=continuous && gasCount>=6?(int)(gasSum/gasCount):-1;
    if (!continuous) gasTiming=false;
    gasSum=gasCount=0; lastAverage=now; evaluateGas(gasRaw,now);
  }
  bool ready; uint32_t width;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { ready=echoReady; width=echoWidth; echoReady=false; }
  if (ready) distanceReading((long)(width*0.1715f),now);
  if (echoPhase && (uint32_t)(now-lastTrigger)>30UL) { ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { echoPhase=0; } distanceReading(-1,now); }
  if ((uint32_t)(now-distanceAt)>500UL) { distanceMm=-1; distanceCount=distanceSlot=0; }
  if ((uint32_t)(now-lastTrigger)>=100UL) {
    lastTrigger=now; ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { echoReady=false; echoPhase=1; }
    digitalWrite(TRIG_PIN,HIGH); delayMicroseconds(10); digitalWrite(TRIG_PIN,LOW);
  }
  outputs(now);
  if ((uint32_t)(now-lastReport)>=1000UL) { lastReport=now; report(now); }
  tx.pump();
}
