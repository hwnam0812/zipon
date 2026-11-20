// Actual delivered V4 sketch, isolated in memory; never opens a hardware port.
#define __AVR_ATmega328P__ 1
#include "../hardware/zipon_uno_v4/zipon_uno_v4.ino"
#include <cassert>
#include <iomanip>
#include <iostream>

static_assert(TRIG_PIN == 9 && ECHO_PIN == 8 && LED_PIN == 7 && BUZZER_PIN == 6, "Delivered V4 pins must match the user's confirmed wiring.");
static_assert(ECHO_PORT_BIT == PB0 && ECHO_INTERRUPT_BIT == PCINT0, "UNO D8 echo must use PB0 / PCINT0.");

const std::string SID(16,'a');
unsigned checks=0;
void checked(const char *label) { ++checks; std::cout << "통과 · " << label << '\n'; }
void raw(const std::string &value) { assert(value.size()<sizeof(inputLine)); strcpy(inputLine,value.c_str()); processLine(); tx.pump(); }
void hello(const std::string &sid=SID) { raw("{\"type\":\"hello\",\"protocol\":\"ZIPON_USB_V4\",\"session\":\""+sid+"\"}"); }
void ping(bool alarm=false) { raw("{\"type\":\"ping\",\"session\":\""+SID+"\",\"intrusion\":"+(alarm?"true":"false")+"}"); }
std::string header(const char *type,unsigned id=1) {
  std::ostringstream out; out << "{\"type\":\"" << type << "\",\"session\":\"" << SID << "\",\"id\":\"" << std::hex << std::setw(8) << std::setfill('0') << id << "\",\"validUntil\":" << std::dec << static_cast<uint32_t>(fakeNow+1800);
  return out.str();
}
void manualCommand(const char *target,bool on,unsigned seconds,unsigned id=1) { raw(header("manual",id)+",\"target\":\""+target+"\",\"on\":"+(on?"true":"false")+",\"seconds\":"+std::to_string(seconds)+"}"); }
void config(bool enabled=true,unsigned id=1) { raw(header("config",id)+",\"gasEnabled\":"+(enabled?"true":"false")+",\"gasThreshold\":200,\"gasRecovery\":150,\"gasHoldMs\":5000,\"gasRecoveryMs\":5000,\"rev\":1}"); }
void reset() {
  fakeTxCapacity=1000000; tx=QueuedSerial(); session[0]=0; used=0; discard=false; lastCommandId=0;
  gasEnabled=gasAlarm=gasTiming=intrusionAlarm=false; thresholdAdc=200; recoveryAdc=150;
  gasHoldMs=gasRecoveryMs=5000; gasSince=configRevision=0; lastPing=0;
  memset(manualAt,0,sizeof(manualAt)); memset(manualMs,0,sizeof(manualMs));
  ledOn=buzzerOn=false; ledSource=buzzerSource=gasState=0; seq=0; gasRaw=100;
  gasSum=gasCount=lastGas=lastAverage=lastReport=lastTrigger=distanceAt=0;
  distanceMm=-1; distanceCount=distanceSlot=0; echoPhase=0; echoReady=false;
  fakeNow=100; fakeAdc=100; PINB=PCICR=PCMSK0=0; memset(pins,0,sizeof(pins)); Serial.input.clear(); Serial.clear(); hello(); Serial.clear();
}
int main(int argc, char **argv) {
  // Emit only isolated test frames for the actual browser parser; never USB/live data.
  if (argc==2 && std::string(argv[1])=="--usb-contract") {
    reset(); setup(); tx.pump(); hello();
    for (int adc : {0,1023,-1,100}) {
      gasRaw=adc; distanceMm=adc==0?-1:adc==1023?4000:adc==-1?80:1438;
      report(fakeNow); tx.pump();
    }
    gasRaw=1023; config();
    manualCommand("led",true,2); report(fakeNow); tx.pump();
    manualCommand("buzzer",true,2,2); report(fakeNow); tx.pump();
    fakeNow=3100; outputs(fakeNow); report(fakeNow); tx.pump();
    std::cout << Serial.output.str(); return 0;
  }
  reset(); setup(); tx.pump(); assert(!gasEnabled && !pins[LED_PIN] && !pins[BUZZER_PIN]);
  assert(PCICR==_BV(PCIE0) && PCMSK0==_BV(PCINT0));
  assert(Serial.output.str().find("ZIPON_USB_V4")!=std::string::npos);
  evaluateGas(1023,100); evaluateGas(1023,60000); assert(!gasAlarm); checked("V4 부팅·감시 꺼짐·명시 시작");

  reset(); setup(); Serial.clear();
  fakeNow=1000; loop(); assert(echoPhase==1 && !pins[TRIG_PIN]);
  PINB=_BV(PB3); PCINT0_vect(); assert(echoPhase==1);
  PINB=_BV(PB0); PCINT0_vect(); assert(echoPhase==2);
  fakeNow=1001; PINB=0; PCINT0_vect(); assert(echoReady && echoWidth==1000 && echoPhase==0);
  loop(); assert(distanceMm==171 && !echoReady);
  checked("Echo D8의 상승·하강으로 거리 측정·이전 D11 신호는 무시");

  reset(); setup(); fakeNow=200; loop(); assert(echoPhase==1);
  fakeNow=231; loop(); assert(distanceMm==-1 && echoPhase==0);
  checked("D8 무응답은 거리 미확인·0cm나 출입으로 판정하지 않음");

  for (int adc : {-1,0,1023}) {
    reset(); gasRaw=adc; config(); assert(!gasEnabled && !gasAlarm && !configRevision);
    assert(Serial.output.str().find("gas_not_ready")!=std::string::npos);
    config(false,2); assert(lastCommandId==2 && !gasEnabled);
  }
  checked("미측정·ADC 양 끝에서 새 가스 감시 시작 거절·꺼짐 설정은 허용");

  reset(); config(); assert(gasEnabled && configRevision==1);
  evaluateGas(200,1000); evaluateGas(100,5000); evaluateGas(200,6000); evaluateGas(200,10999); assert(!gasAlarm);
  evaluateGas(1023,11000); assert(gasAlarm); checked("평균 출력의 연속 초과·지속 확인·최대 ADC 포함");
  evaluateGas(0,12000); evaluateGas(-1,17000); assert(gasAlarm && gasState==4);
  evaluateGas(149,18000); evaluateGas(0,22000); evaluateGas(149,23000); evaluateGas(149,27999); assert(gasAlarm);
  evaluateGas(149,28000); assert(!gasAlarm && gasState==1); checked("0·실패로 해제 안 함·복귀도 연속 확인");

  reset(); manualCommand("led",true,15); assert(ledOn && !buzzerOn);
  fakeNow=200; ping(); manualCommand("buzzer",true,2,2); assert(ledOn && buzzerOn);
  fakeNow=2200; ping(); outputs(fakeNow); assert(ledOn && !buzzerOn); checked("LED·부저 독립 시간과 2초 시험 종료");
  fakeNow=15100; ping(); outputs(fakeNow); assert(!ledOn); checked("수동 15초 상한 자동 종료");

  reset(); manualCommand("buzzer",true,2);
  fakeNow=1000; ping(); manualCommand("buzzer",true,2); assert(manualAt[1]==100);
  fakeNow=2100; outputs(fakeNow); assert(!buzzerOn); checked("중복 요청은 수동 시간을 연장하지 않음");
  for (unsigned n=2;n<8;n++) { ping(); manualCommand("led",false,0,n); }
  manualCommand("buzzer",true,2,1); assert(!manualMs[1] || !manual(1,fakeNow));
  assert(Serial.output.str().find("replay")!=std::string::npos); checked("오래된 식별값은 여러 요청 뒤에도 재실행 안 함");

  reset(); manualCommand("led",true,15); manualCommand("buzzer",true,15,2); ping(true);
  gasAlarm=true; gasEnabled=true; gasState=3; outputs(fakeNow);
  assert(ledSource==2 && buzzerSource==2);
  manualCommand("led",false,0,3); manualCommand("buzzer",false,0,4);
  assert(ledOn && buzzerOn && ledSource==2 && buzzerSource==2); checked("가스 자동 경보 중 수동 끄기가 자동 출력을 억제하지 않음");
  gasAlarm=false; outputs(fakeNow); assert(!ledOn && buzzerOn && buzzerSource==3); checked("출입 의심 자체는 부저만 사용");

  reset(); manualCommand("led",true,15); manualCommand("buzzer",true,15,2); ping(true);
  gasAlarm=true; gasEnabled=true; outputs(fakeNow); gasAlarm=false; outputs(fakeNow);
  assert(ledSource==1 && buzzerSource==3); ping(false); outputs(fakeNow);
  assert(ledSource==1 && buzzerSource==1); checked("자동 상황 종료 후 유효한 수동 요청 복귀·시간 연장 없음");

  reset(); manualCommand("led",true,15); ping(true); fakeNow=3100; outputs(fakeNow);
  assert(!ledOn && !buzzerOn && !intrusionAlarm); gasEnabled=gasAlarm=true; outputs(fakeNow);
  assert(ledSource==2 && buzzerSource==2); checked("통신 3초 단절 시 수동·출입 종료·가스 유지");

  reset(); config(); gasAlarm=true; gasState=3; hello(std::string(16,'b'));
  assert(gasAlarm && gasEnabled); checked("새 USB 연결로 이미 진행 중인 보드 가스 경보를 지우지 않음");
  reset(); config(); hello(std::string(16,'b')); assert(!gasEnabled && !configRevision); checked("경보 없는 새 USB 연결은 감시를 임의 재시작하지 않음");

  reset(); config(); gasAlarm=true; gasState=3; config(false,2); assert(gasEnabled && gasAlarm);
  assert(Serial.output.str().find("alarm_active")!=std::string::npos); checked("가스 경보 중 설정·감시 종료 거절");

  reset();
  const std::string valid=header("manual")+",\"target\":\"led\",\"on\":true,\"seconds\":2}";
  for (const std::string &bad : {valid+"junk", valid.substr(0,valid.size()-1), header("manual")+",\"target\":\"led\",\"on\":true,\"on\":false,\"seconds\":2}", header("manual")+",\"target\":\"led\",\"on\":\"true\",\"seconds\":2}", header("manual")+",\"target\":\"led\",\"on\":true,\"seconds\":2e0}", header("manual")+",\"target\":\"led\",\"on\":true,\"seconds\":{}}"}) raw(bad);
  assert(!ledOn && !lastCommandId); checked("잘림·중복 키·중첩·과학 표기·잘못된 JSON 거절");
  manualCommand("led",true,16); manualCommand("buzzer",true,0); assert(!ledOn && !buzzerOn); checked("출력 범위 밖과 잘못된 켜기 시간 거절");

  reset(); fakeNow=4000; raw("{\"type\":\"manual\",\"session\":\""+SID+"\",\"id\":\"00000001\",\"validUntil\":5000,\"target\":\"led\",\"on\":true,\"seconds\":2}");
  assert(!ledOn); ping();
  raw("{\"type\":\"manual\",\"session\":\""+SID+"\",\"id\":\"00000002\",\"validUntil\":4000,\"target\":\"led\",\"on\":true,\"seconds\":2}");
  assert(!ledOn); checked("만료된 연결·기한이 지난 요청은 실행 안 함");

  reset(); Serial.input=std::string(600,'x')+valid+"\n";
  for (int n=0;n<20;n++) loop(); assert(!ledOn);
  Serial.input=valid+"\n"; for (int n=0;n<10;n++) loop(); assert(ledOn); checked("너무 긴 줄 전체 폐기·다음 정상 줄 복구");

  reset(); distanceReading(120,1000); distanceReading(300,1100); distanceReading(120,1200); assert(distanceMm==120);
  distanceReading(-1,1300); assert(distanceMm==-1 && !distanceCount);
  distanceReading(400,1400); assert(distanceMm==400); checked("초음파 중앙값·NO ECHO·복구 버퍼 초기화");

  reset(); gasEnabled=true; evaluateGas(200,0xfffff000U); evaluateGas(200,904); assert(gasAlarm);
  fakeNow=0xfffffff0U; lastPing=fakeNow; manualAt[0]=fakeNow; manualMs[0]=2000;
  assert(manual(0,20)); assert(!manual(0,2000)); checked("millis 오버플로에서도 지속·수동 만료 유지");

  reset(); gasRaw=1023; distanceMm=4000; configRevision=2147483647; seq=4294967294;
  fakeTxCapacity=0; report(4294967295U); assert(tx.freeBytes()>=31);
  assert(Serial.output.str().empty());
  gasEnabled=true; gasAlarm=true; fakeNow=500; outputs(fakeNow); assert(pins[LED_PIN] && pins[BUZZER_PIN]);
  for (int n=0;n<30;n++) { fakeTxCapacity=32; loop(); }
  const std::string frame=Serial.output.str();
  assert(frame.find("\"type\":\"telemetry\"")==1 && frame.find("\"config\":2147483647}")!=std::string::npos && frame.size()<480);
  checked("송신 대기 중에도 센서·출력 처리 지속·최대 JSON 줄 완전 전송");
  std::cout << "V4 펌웨어 격리 검사 " << checks << "개 통과 (실물 시험 아님)\n";
}
