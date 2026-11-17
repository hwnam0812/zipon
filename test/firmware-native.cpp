// Exercise the actual delivered sketch, with time/pins/Serial replaced in RAM.
#define __AVR_ATmega328P__ 1
#include "../hardware/zipon_uno/zipon_uno.ino"
#include <cassert>
#include <iostream>

const char *SID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const char *C1 = "12345678-1234-1234-1234-123456789abc";
const char *C2 = "22345678-1234-1234-1234-123456789abc";
void parse(const std::string &s) { assert(s.size()<sizeof(line)); strcpy(line,s.c_str()); processLine(); }
void tick(uint32_t value) { fakeNow=value; updateOutputs(fakeNow); }
void ping() { parse(std::string("PING ")+SID); }
void reset() {
  cfg={120,80,1000,false,true,false,0,100,10000};
  session[0]=0; strcpy(revision,"0000000000000000");
  memset(recentIds,0,sizeof(recentIds)); recentSlot=0; used=0; discardLine=false;
  manualMs[0]=manualMs[1]=offMs[0]=offMs[1]=muteMs=0;
  gasTiming=gasAlarm=doorPulse=ledOn=buzzerOn=false;
  ledSource=buzzerSource='N'; doorState=doorCandidate=doorBaseline='U';
  gasStatus=0; gasAdc=100; distanceMm=120; sequence=eventSequence=0;
  lastGas=lastAverage=lastReport=lastTrigger=distanceAt=0;
  gasSum=gasCount=0; echoPhase=0; echoReady=false; fakeNow=100; Serial.clear(); Serial.input.clear();
  parse(std::string("HELLO ")+SID); Serial.clear();
}
void configure(bool gas=true) {
  parse(std::string("CFG ")+SID+" 1111111111111111 120 80 1000 1 1 "+(gas?"1":"0")+" 100 100 10000");
}
void set(const char *id, const char *target, const char *action, int seconds) {
  parse(std::string("SET ")+SID+" "+id+" "+target+" "+action+" "+std::to_string(seconds));
}
size_t occurrences(const std::string &needle) {
  auto text=Serial.output.str(); size_t n=0,pos=0;
  while ((pos=text.find(needle,pos))!=std::string::npos) { n++;pos+=needle.size(); } return n;
}
int main() {
  reset(); setup(); assert(!pins[8] && !pins[6] && !cfg.gasEnabled);
  evaluateGas(1023,100); evaluateGas(1023,60000); assert(!gasAlarm && gasStatus==0);
  std::cout << "통과 · 부팅 시 꺼짐과 감시 명시 시작\n";

  reset(); configure(); evaluateGas(200,1000); evaluateGas(100,9000); evaluateGas(200,10000); evaluateGas(200,19999);
  assert(!gasAlarm && gasStatus==2); evaluateGas(1023,20000); assert(gasAlarm && gasStatus==3);
  evaluateGas(1023,30000); assert(occurrences("GAS_ALERT")==1);
  std::cout << "통과 · 지속 상승만 경고·포화 출력 포함·중복 경고 방지\n";

  evaluateGas(0,31000); assert(gasAlarm && gasStatus==4); evaluateGas(-1,32000); assert(gasAlarm && gasStatus==4);
  tick(32000); assert(ledSource=='G' && buzzerSource=='G');
  evaluateGas(149,33000); evaluateGas(0,42000); evaluateGas(149,43000); evaluateGas(149,52999); assert(gasAlarm);
  evaluateGas(149,53000); assert(!gasAlarm && gasStatus==1 && occurrences("GAS_BELOW")==1);
  std::cout << "통과 · 실패·0으로 경고 해제 안 함·복귀도 지속 확인\n";

  reset(); configure(); evaluateGas(200,1000); fakeNow=10000; ping(); configure(); evaluateGas(200,11000); assert(gasAlarm);
  std::cout << "통과 · 같은 설정 반복 수신은 감지 시간을 초기화하지 않음\n";

  reset(); evaluateDoor(120,1000); evaluateDoor(120,3000); assert(doorState=='U'); configure(false);
  evaluateDoor(120,4000); evaluateDoor(120,5000); assert(doorState=='C' && eventSequence==0);
  evaluateDoor(500,6000); evaluateDoor(500,6999); assert(doorState=='C'); evaluateDoor(500,7000);
  assert(doorState=='O' && occurrences("DOOR_OPEN")==1); tick(7000); assert(ledSource=='D' && buzzerSource=='D');
  tick(7250); assert(ledOn && !buzzerOn); tick(7500); assert(!ledOn && !buzzerOn);
  evaluateDoor(120,8000); evaluateDoor(120,9000); assert(occurrences("DOOR_CLOSED")==1);
  std::cout << "통과 · 문 보정·지속 확인·첫 기준 제외·짧은 LED·부저 반응\n";

  evaluateDoor(-1,10000); assert(doorState=='U'); evaluateDoor(500,11000); evaluateDoor(500,12000);
  assert(doorState=='O' && occurrences("DOOR_OPEN")==1); // Recovery is not a fabricated movement.
  std::cout << "통과 · NO ECHO는 열림 아님·복구 첫 값은 새 기준\n";

  reset(); tick(1000); ping(); set(C1,"L","ON",10); assert(ledOn && !buzzerOn);
  tick(1100); ping(); set(C2,"B","TEST",2); assert(ledOn && buzzerOn);
  tick(2500); ping(); set(C2,"B","TEST",2); tick(3100); assert(ledOn && !buzzerOn);
  std::cout << "통과 · LED·부저 독립·중복 시험은 시간을 연장하지 않음\n";

  tick(5500); assert(!ledOn && !buzzerOn);
  cfg.gasEnabled=true; gasAlarm=true; tick(6000); assert(ledSource=='G' && buzzerSource=='G');
  parse("MANUAL_OFF"); tick(6001); assert(ledSource=='G' && buzzerSource=='G');
  std::cout << "통과 · USB 신호 단절은 수동만 종료·보드 자동 반응 유지\n";

  reset(); configure(); gasAlarm=true; tick(1000); ping(); set(C1,"L","OFF",30);
  assert(!ledOn && ledSource=='P' && buzzerSource=='G');
  tick(30999); assert(ledSource=='P'); tick(31000); assert(ledSource=='G');
  std::cout << "통과 · LED 끄기 30초 후 자동 반응 복귀\n";

  reset(); configure(); gasAlarm=true; tick(1000); ping(); set(C1,"A","MUTE",60);
  assert(ledSource=='G' && buzzerSource=='P' && !buzzerOn);
  tick(2000); ping(); set(C2,"B","TEST",2); assert(buzzerOn && buzzerSource=='M');
  tick(4000); assert(!buzzerOn && buzzerSource=='P'); tick(61000); assert(buzzerSource=='G');
  std::cout << "통과 · 자동 경고음 60초 일시 정지·수동 시험 별도·자동 재개\n";

  reset(); configure(); gasAlarm=true; tick(1000); ping(); set(C1,"B","OFF",30);
  set(C2,"A","RESUME",0); assert(buzzerSource=='G' && offMs[1]==0 && muteMs==0);
  std::cout << "통과 · 경고음 재개는 부저 끄기와 일시 정지 해제\n";

  reset(); tick(4000); set(C1,"B","ON",10); assert(!buzzerOn && occurrences("REJECTED")==1);
  ping(); parse(std::string("START ")+SID+" "+C1+" 10"); parse(std::string("SET ")+std::string(32,'b')+" "+C1+" B ON 10");
  set(C1,"B","ON",16); assert(!buzzerOn);
  parse(std::string("CFG ")+SID+" 2222222222222222 120 80 1000 1 1 1 1000 100 10000"); assert(!cfg.gasEnabled);
  std::cout << "통과 · 구형·다른 연결·만료·범위 밖 요청 거부\n";

  reset(); Serial.input=std::string(230,'x')+" SET "+SID+" "+C1+" B ON 10\n";
  for(int i=0;i<15;i++) { loop(); }
  assert(!buzzerOn);
  std::cout << "통과 · 긴 USB 줄을 버리고 잘린 명령을 실행하지 않음\n";

  reset(); assert(remaining(20,0xfffffff0U,50)==14); assert(remaining(50,0xfffffff0U,50)==0);
  cfg.gasEnabled=true; cfg.gasHoldMs=5000; evaluateGas(200,0xfffff000U); evaluateGas(200,904); assert(gasAlarm);
  std::cout << "통과 · millis 오버플로에도 만료·지속 감지 유지\n";

  reset(); configure(false); fakeNow=2000; report(fakeNow);
  assert(Serial.output.str().find("R aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 2000 100 120 U 0 0 0 0 N N 0 0 0 1111111111111111")!=std::string::npos);
  std::cout << "통과 · 전달 스케치의 V3 보고 형식\n";
  std::cout << "펌웨어 격리 검사 15개 통과 (실물 시험 아님)\n";
}
