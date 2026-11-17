import { useState } from "react";
import { Cable, Check, CheckCircle2, CircleAlert, Copy, DoorOpen, Wind, House, KeyRound, Lightbulb, Radio, Siren, Smartphone, Wifi, WifiOff } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import HardwareDownload from "../home/HardwareDownload";
import { IconBadge, LoadingState, Modal, PageHeading, Pill, SafetyNote, UnavailableFeature } from "../home/ui";
import OutputControl from "../home/OutputControl";
import SensorSettings from "../home/SensorSettings";
import { kstClock } from "../lib/home-model";

export default function Devices() {
  const { state, actions } = useHome();
  const [keyOpen, setKeyOpen] = useState(false), [token, setToken] = useState("");
  const [rotating, setRotating] = useState(false), [pairBusy, setPairBusy] = useState(false);
  const s = state.snapshot;
  if (!s) return <LoadingState/>;
  const online = s.online && !state.error;
  const gas = s.sensor.gasSensor === "MQ-135";
  const replied = Boolean(s.sensor.board);
  const connectionLabel = s.sensor.lastSeen ? "연결 끊김" : s.device.paired ? "첫 수신 대기" : "연결 전";
  async function pair() {
    setPairBusy(true);
    try {
      const data = await actions.request<{ token: string }>("/device", { method: "POST", body: "{}" });
      setToken(data.token); setRotating(false); setKeyOpen(true); await actions.refresh();
    } catch (e) { actions.notify((e as Error).message, "error"); }
    finally { setPairBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(token); actions.notify("기기 연결 키를 복사했어요."); }
    catch { actions.notify("자동 복사가 되지 않았어요. 표시된 연결 키를 직접 선택해 복사해 주세요.", "info"); }
  }
  const closeKey = () => { setKeyOpen(false); setToken(""); };
  return <>
    <PageHeading title="우리 집 기기" description="앱의 준비 상태와 실제 기기 연결을 따로 확인해요." aside={<Pill tone={online ? "positive" : "neutral"}>{online ? "측정값 수신 중" : connectionLabel}</Pill>}/>
    <div className="device-layout"><div className="device-main">
      <section className="panel device-overview">
        <div className="panel-heading"><h2><Radio size={20}/>{s.device.name}</h2><Pill tone={online ? "positive" : "neutral"}><span className="pill-dot"/>{online ? "연결됨" : connectionLabel}</Pill></div>
        <p className={`device-status ${!online ? "is-offline" : ""}`}><span/>{online && s.sensor.lastSeen ? `마지막 측정값 ${kstClock(s.sensor.lastSeen, true)} · 3초마다 화면 갱신` : state.error ? "앱 연결을 확인하지 못했어요. 현재 상태를 알 수 없어요." : s.sensor.lastSeen ? "15초 이상 새 측정값이 오지 않아 현재 상태를 확인할 수 없어요." : "실제 기기에서 첫 측정값을 보내면 연결 상태가 바뀌어요."}</p>
        <div className="device-diagram" aria-hidden="true"><div className="diagram-house"><House size={39} strokeWidth={1.4}/></div><div className="diagram-wifi">{online ? <Wifi size={24} strokeWidth={1.4}/> : <WifiOff size={24} strokeWidth={1.4}/>}</div><div className="diagram-phone"><Smartphone size={34} strokeWidth={1.3}/></div></div>
        <div className="device-parts">{[{ icon: Wind, name: "가스 센서", sub: "MQ-135 · 농도·안전 판정 안 함", tone: "orange" as const, measured: gas && s.sensor.gasVoltageV != null && s.sensor.gasAdc != null }, { icon: DoorOpen, name: "초음파 센서", sub: "거리·현관문 상태", tone: "blue" as const, measured: s.sensor.distance !== null }, { icon: Lightbulb, name: "LED", sub: "실제 빛은 현장 확인", tone: "green" as const, measured: replied }, { icon: Siren, name: "부저", sub: "실제 소리는 현장 확인", tone: "green" as const, measured: replied }].map(part => <div className="device-part" key={part.name}><IconBadge icon={part.icon} tone={part.tone}/><h3>{part.name}</h3><p>{part.sub}</p><Pill tone={online && part.measured ? "positive" : "neutral"}>{!online ? "연결 대기" : part.name === "부저" || part.name === "LED" ? replied ? "출력 상태 응답 수신" : "새 코드 필요" : !part.measured ? "측정 실패" : "측정값 수신"}</Pill></div>)}</div>
      </section>
      <section className="panel usb-guide">
        <div className="panel-heading"><h2>노트북으로 USB 연결</h2><Pill>코드 준비됨</Pill></div>
        <p>아두이노 ↔ USB ↔ 노트북 연결 프로그램 ↔ 집온 순서로 연결해요. 블루투스는 필요하지 않아요.</p>
        <dl className="usb-pins"><div><dt>표시 LED</dt><dd>D8 → 330Ω 직렬 저항 → LED + · LED − → GND</dd></div><div><dt>부저</dt><dd>D6 · 작은 수동 피에조 · 실제 모델·전류 확인</dd></div><div><dt>초음파</dt><dd>Trig D9 · Echo D11 · 5V형 HC-SR04 확인</dd></div><div><dt>MQ-135</dt><dd>AO → A5 · DO 미연결 · D10 미사용</dd></div><div><dt>센서 전원</dt><dd>별도 안정화 5V · UNO와 GND 공통</dd></div></dl>
        <p className="inline-warning">이미지의 UNO R3와 HC-SR04 호환 초음파 센서를 가정했어요. 보드·부저 모델이 다르면 설치 전 확인해 주세요.</p>
        <p className="inline-warning">USB와 외부 전원을 모두 끄고 먼지 센서·전용 저항·콘덴서를 제거해요. D8 LED 저항은 유지해요. 외부 전원의 +를 UNO 5V/VIN에 연결하지 말고 GND만 공통으로 해요. 실제 모듈의 VCC·GND·AO·DO 글씨를 확인해 주세요.</p>
        <a className="wiring-preview" href="/downloads/zipon-mq135-wiring.svg" target="_blank" rel="noreferrer" aria-label="MQ-135 연결 회로도 크게 보기 (새 탭)"><img src="/downloads/zipon-mq135-wiring.svg" alt="MQ-135 VCC는 별도 5V 양극, GND는 전원 음극·UNO GND 공통, AO는 A5, DO는 미연결인 회로도. 초음파 D9·D11, LED D8·330Ω, 수동 피에조 D6을 함께 표시해요." width="1000" height="1280" loading="lazy"/></a>
        <HardwareDownload/>
        <ol><li>배선·전원을 확인하고 안내서대로 새 스케치를 업로드해요.</li><li>시리얼 모니터를 닫고 새 노트북 연결 프로그램을 실행해요.</li><li>게시된 앱 주소와 기기 연결 키를 입력해요. 키는 보드에 넣지 않아요.</li><li>문 거리 보정과 LED·부저의 실제 작동·자동 종료를 확인해요.</li><li>예열·기준 ADC를 직접 확인하고 이번 연결의 가스 감시를 켠 뒤 기준값을 저장해요.</li></ol>
        <p>노트북·USB 프로그램·인터넷이 유지돼야 앱 전송과 원격 제어가 돼요. 연결이 끊겨도 보드 전원이 남으면 이미 적용된 자동 반응은 계속돼요. USB를 빼서 전원까지 끊기면 보드 감지도 멈춰요. 끊긴 동안의 문 동작 기록은 빠질 수 있어요.</p>
        <p className="inline-warning">MQ-135는 원시 ADC·전압과 실습용 출력 변화만 다뤄요. <a href="https://www.winsen-sensor.com/d/files/manual/mq135.pdf" target="_blank" rel="noreferrer">Winsen MQ135 사양서</a>의 초기 예열은 48시간 초과예요. 실제 모듈의 예열·재인가 안정화 지침도 확인해 주세요. 앱은 예열 완료·가스 종류·농도·누출·안전을 판단하지 않아요. 가스를 방출해 시험하지 마세요.</p>
      </section>
      <section className="panel connection-readiness"><div className="panel-heading"><h2>연결 전 준비 상태</h2><Pill>실제 기기 검증 전</Pill></div><ul className="ready-list">{["가족 비밀번호 보호·기록·여러 안심 시간 저장", "문 지속 감지·실습용 가스 출력 변화 감시", "LED·부저 개별 요청과 보드 실행 응답 처리", "UNO 스케치·노트북 USB 연결 코드 제공"].map(text => <li key={text}><CheckCircle2 size={17}/><span>{text}</span><Pill tone="positive">코드 준비됨</Pill></li>)}</ul><UnavailableFeature title="앱 종료·잠금 중 비상 알림">문자·전화와 화면을 닫은 뒤의 즉시 알림은 연결되지 않았어요. 현재는 화면 안 알림과 열린 화면의 브라우저 알림만 지원해요.</UnavailableFeature><p className="field-help">이전 단독 초음파 검사에서도 NO ECHO였어요. 코드 변경만으로 해결됐다고 볼 수 없으니 전원·접점·센서를 실물로 확인해 주세요. LED·부저 소리도 현장 확인이 필요해요.</p></section>
      <SensorSettings/>
      {s.sensor.board && <OutputControl/>}
    </div><aside className="device-aside">
      <section className="panel pairing-card"><div className="pairing-icon"><Cable size={23} strokeWidth={1.5}/></div><h2>기기 연결 키 준비</h2><p>{s.device.paired ? "연결 키는 발급됐어요. 노트북 연결 프로그램에 입력하고 실제 측정값을 보내야 연결돼요." : "집의 기기만 측정값과 제어 응답을 보낼 수 있도록 전용 연결 키를 만들어요."}</p><button type="button" className="primary-button" disabled={pairBusy || Boolean(state.pending)} onClick={s.device.paired ? () => setRotating(true) : () => void pair()}><KeyRound size={15}/>{pairBusy ? "연결 키 만드는 중…" : s.device.paired ? "기기 연결 키 바꾸기" : "기기 연결 키 만들기"}</button><p className="field-help">가족 비밀번호와 기기 연결 키는 서로 달라요. 기기에는 가족 비밀번호를 넣지 않아요.</p></section>
      <ol className="panel connection-steps"><li><b>USB 케이블로 노트북에 연결</b><p>데이터 통신이 가능한 케이블을 써요. 인터넷 연결은 노트북이 담당해요.</p></li><li><b>코드 업로드와 연결 프로그램 실행</b><p>왼쪽 안내 묶음을 받아 설치해요. 부저 종류·전류와 배선을 먼저 확인해요.</p></li><li><b>설치한 자리에서 검증</b><p>문 거리 기준을 보정하고, 안전한 상황에서 짧게 부저와 자체 자동 종료를 확인해요.</p></li></ol>
      <details className="panel protocol-details"><summary>개발용 연결 규칙 보기</summary><p>새 스케치와 연결 프로그램은 ZIPON_AUTO_V3를 함께 사용해요. 구형 스케치와 섞지 마세요.</p><ul><li>새 측정은 약 2초 간격이에요. 실패값은 null이며 무응답을 문 열림으로 보내지 않아요.</li><li>앱 설정 저장과 보드 적용 응답을 구분해요. 가스 감시는 이번 USB 연결에서만 켜요.</li><li>제어는 요청 → 전달 승인 → USB 명령 → 보드 실행 응답 순서예요. 전달 승인만으로 실행됐다고 표시하지 않아요.</li><li>같은 요청은 다시 실행하지 않고, 기한이 지나거나 USB 연결이 바뀐 요청은 거절해요.</li><li>수동 출력은 최대 15초·연결 신호 단절 3초, 출력 끄기 30초·자동 경고음 쉬기 60초예요.</li><li>자동 반응은 보드 전원이 남으면 계속될 수 있어요. 물리적인 안전 차단 장치가 아니에요.</li></ul></details>
    </aside></div>
    <SafetyNote/>
    <Modal open={keyOpen} onClose={closeKey} title="기기 연결 키를 만들었어요"><p className="key-warning">이 키는 지금 한 번만 보여드려요. 노트북 연결 프로그램에 입력하고 다른 사람에게 공유하지 마세요.</p><div className="key-display"><code>{token}</code><button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14}/>연결 키 복사</button></div><p className="key-warning">아두이노 코드에는 키를 넣지 않아요. 실제 보드에서 값을 보내기 전까지 연결 대기 상태예요.</p><div className="modal-actions"><button className="primary-button" type="button" onClick={closeKey}><Check size={16}/>연결 키를 보관했어요</button></div></Modal>
    <Modal open={rotating} onClose={() => setRotating(false)} title="기기 연결 키를 바꿀까요?"><div className="inline-warning"><CircleAlert size={18}/><p>기존 연결과 대기 중인 제어 요청이 무효가 돼요. 이미 켜진 출력이나 보드의 자동 반응을 물리적으로 끄는 기능은 아니에요. 실제 출력을 현장에서 확인해 주세요.</p></div><p className="key-warning">노트북 연결 프로그램을 다시 실행하고 새 연결 키를 입력해야 집의 소식이 도착해요.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setRotating(false)}>취소</button><button type="button" className="primary-button" disabled={pairBusy} onClick={() => void pair()}>{pairBusy ? "바꾸는 중…" : "연결 키 바꾸기"}</button></div></Modal>
  </>;
}
