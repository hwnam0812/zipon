import { Link } from "react-router";
import { ArrowUpRight, Cable, CalendarDays, Check, ChevronRight, Clock3, DoorClosed, DoorOpen, Wind, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import HomeScene from "../home/HomeScene";
import { useHome } from "../home/HomeProvider";
import SirenControl from "../home/SirenControl";
import OutputControl from "../home/OutputControl";
import { EmptyState, EventList, IconBadge, LoadingState, PageHeading, Pill, SafetyNote, Toggle } from "../home/ui";
import { activeQuietWindows, gasStatusLabels, isQuietTime, kstClock, quietDaysLabel } from "../lib/home-model";

export default function Home() {
  const { state } = useHome();
  const s = state.snapshot;
  if (state.loading || !s) return <><PageHeading title="우리 집 한눈에" description="집의 작은 변화까지, 대신 살펴볼게요."/>{state.error ? <EmptyState title="우리 집 소식을 기다리고 있어요" description="연결을 확인하고 위의 ‘다시 불러오기’를 눌러 주세요." icon={WifiOff}/> : <LoadingState/>}</>;
  const online = s.online && !state.error, legacyRisk = s.sensor.fireStatus === "risk";
  const board = s.sensor.board, gasRisk = Boolean(board?.gasAlarm), risk = legacyRisk || gasRisk;
  const gas = s.sensor.gasSensor === "MQ-135";
  const gasMeasured = gas && s.sensor.gasVoltageV != null && s.sensor.gasAdc != null;
  const endpoint = gasMeasured && (s.sensor.gasAdc === 0 || s.sensor.gasAdc === 1023);
  const incomplete = !gasMeasured || endpoint || s.sensor.distance === null || s.sensor.doorStatus === "unknown";
  const connectionLabel = s.sensor.lastSeen ? "연결 끊김" : s.device.paired ? "연결 대기" : "연결 전";
  const open = s.sensor.doorStatus === "open";
  const quiet = isQuietTime(s.settings, Date.parse(s.serverTime));
  const date = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "long" }).format(new Date(s.serverTime));
  const heading = gasRisk ? <>가스 출력 이상,<br/>상황을 확인해 주세요.</> : legacyRisk ? <>이전 화재 의심 기록을<br/>확인해 주세요.</> : !online ? <>집의 소식을<br/>기다리고 있어요.</> : incomplete ? <>일부 센서의 소식을<br/>확인하고 있어요.</> : open ? <>우리 집 현관문이<br/>열려 있어요.</> : <>현관문 거리와<br/>센서 출력을 살펴봐요.</>;
  const description = gasRisk ? "보드가 실습용 출력 변화 경고를 보고했어요. 화재 여부를 직접 확인해 주세요. 측정 실패·연결 끊김은 경고 해제나 안전을 뜻하지 않아요." : legacyRisk ? "이전에 남은 경보를 유지하고 있어요. MQ-135로 확인하거나 해제하지 않으니 집의 상황을 직접 확인해 주세요." : !online ? "연결을 확인하기 전에는 집의 현재 상태를 알 수 없어요." : incomplete ? "측정에 실패했거나 보정이 필요한 센서가 있어요. 기기 관리에서 새 코드와 배선·전원을 확인해 주세요." : "문 동작과 직접 정한 가스 출력 변화를 살펴봐요. 가스 종류·농도·누출이나 집의 안전을 판정하지 않아요.";
  return <>
    <PageHeading title="우리 집 한눈에" description="집의 작은 변화까지, 대신 살펴볼게요." aside={<div className="heading-date"><CalendarDays size={15}/><span>{date}</span></div>}/>
    <div className="dashboard-top">
      <div className="home-overview">
      <section className={`home-hero ${risk ? "home-hero--risk" : !online ? "home-hero--offline" : ""}`}>
        <div className="hero-copy"><div className="hero-chip"><ShieldCheck size={14}/>{risk ? "지금 확인해 주세요" : !online ? "연결 확인이 필요해요" : "안심 모니터링"}</div><h2>{heading}</h2><p className="hero-description">{description}</p><div className="hero-connection">{online ? <Wifi size={14}/> : <WifiOff size={14}/>}<span>{online ? `마지막 수신 ${kstClock(s.sensor.lastSeen!, true)}` : s.sensor.lastSeen ? "15초 이상 새 측정값이 도착하지 않았어요" : s.device.paired ? "연결 키는 준비됐고 첫 측정값을 기다리고 있어요" : "아직 실제 기기를 연결하지 않았어요"}</span></div></div>
        <HomeScene mood={risk ? "warning" : !online || incomplete ? "offline" : "calm"}/><Link className="hero-detail" to="/devices" aria-label="기기 상태 확인"><ArrowUpRight size={18}/></Link>
      </section>
    <div className="sensor-grid">
      <section className="panel sensor-card">
        <div className="sensor-heading"><IconBadge icon={Wind} tone={risk ? "red" : "orange"}/><h2>가스 센서 출력</h2><Pill tone={risk ? "danger" : online && endpoint ? "warning" : "neutral"}><span className="pill-dot"/>{gasRisk ? "출력 이상 기록 유지" : legacyRisk ? "이전 경보 유지" : !online ? connectionLabel : !gasMeasured ? "측정 확인" : endpoint ? "범위 끝값" : board ? gasStatusLabels[board.gasStatus] : "참고용"}</Pill></div>
        <div className="sensor-reading"><div><h3>{gasRisk ? "가스 출력 이상·화재 여부 확인 필요" : legacyRisk ? "이전 화재 의심 기록 확인 필요" : !online ? "현재 상태를 알 수 없어요" : !gas ? "MQ-135용 새 코드를 연결해 주세요" : !gasMeasured ? "측정값을 확인해 주세요" : endpoint ? "배선·전원·출력 범위를 확인해 주세요" : "가스 누출 여부는 판단하지 않아요"}</h3><p>MQ-135 · 원시 전압{online && gasMeasured ? ` · ADC ${s.sensor.gasAdc}` : ""}</p></div><div className={`sensor-number ${risk ? "is-risk" : ""}`}>{online && gasMeasured ? s.sensor.gasVoltageV!.toFixed(2) : "—"}<span>V</span></div></div>
        {board && <p className="sensor-automation">{!online ? "현재 출력 감시 상태는 확인되지 않았어요." : `${gasStatusLabels[board.gasStatus]}${endpoint ? " · ADC 범위 끝값" : ""}`} {board.gasStatus === "disabled" && s.settings.gasEnabled ? "USB 재연결 후에는 감시를 직접 다시 켜 주세요." : ""}</p>}
        <div className="sensor-foot"><span className="sensor-led"/><span>실습용 출력 변화 · 농도·안전 판정 안 함</span><Link to="/devices" aria-label="가스 센서 연결 안내"><SettingsMini/></Link></div>
      </section>
      <section className="panel sensor-card"><div className="sensor-heading"><IconBadge icon={online && open ? DoorOpen : DoorClosed} tone="blue"/><h2>현관문 상태</h2><Pill tone={!online || s.sensor.doorStatus === "unknown" ? "neutral" : open ? quiet ? "danger" : "blue" : "positive"}><span className="pill-dot"/>{!online ? connectionLabel : s.sensor.doorStatus === "unknown" ? "측정 확인" : open ? "열림 감지" : "닫힘 감지"}</Pill></div><div className="sensor-reading"><div><h3>{!online ? "현재 상태를 알 수 없어요" : s.sensor.distance === null ? "초음파 응답 없음·측정 실패" : s.sensor.doorStatus === "unknown" ? "거리 보정·지속 확인이 필요해요" : open ? "열려 있어요" : "닫혀 있어요"}</h3><p>초음파 거리 {online && s.sensor.distance !== null ? `${s.sensor.distance.toFixed(1)} cm` : "미확인"}</p></div><div className="sensor-number">{s.todayOpenCount.toLocaleString("ko-KR")}<span>회</span></div></div><div className="sensor-foot"><span className="sensor-led sensor-led--blue"/><span>문 동작 자동 반응과 안심 시간 알림은 별개예요</span><Link to="/history" aria-label="현관문 기록 모두 보기"><ChevronRight size={15}/></Link></div></section>
    </div>
    {board && <div className="board-configuration"><Pill tone={online && board.configRevision === s.boardConfig.revision ? "positive" : "warning"}>{!online ? "보드 설정 미확인" : board.configRevision === s.boardConfig.revision ? "저장한 설정 적용 응답 수신" : "보드의 설정 적용 대기"}</Pill><span>보드 출력은 마지막 측정 순간의 보고이며 실제 빛·소리를 보증하지 않아요.</span></div>}
      </div>
      {s.sensor.lastSeen && !board ? <SirenControl/> : <OutputControl/>}
    </div>
    <div className="dashboard-bottom">
      <section className="panel recent-panel"><div className="panel-heading"><h2>오늘의 현관문 기록<span className="count-label">한국 시간 기준</span></h2><Link to="/history" className="text-link">전체 보기<ChevronRight size={14}/></Link></div>{s.events.length ? <EventList events={s.events.slice(0, 3)} variant="recent"/> : <EmptyState title="오늘 감지된 문 움직임이 없어요" description="기기가 보낸 문 열림·닫힘만 이곳에 기록돼요." icon={DoorClosed}/>}</section>
      <QuietPanel/>
    </div>
    {!online && !s.sensor.lastSeen && <div className="connection-prerequisite"><Cable size={20}/><div><b>USB 연결 코드 준비됨 · 실제 기기 검증 전</b><p>기기 관리에서 코드와 설치 안내를 받아 노트북에서 실행해 주세요.</p></div><Link to="/devices" className="text-link">연결 안내 보기<ChevronRight size={14}/></Link></div>}
    <SafetyNote/>
  </>;
}
function QuietPanel() {
  const { state, actions } = useHome();
  const s = state.snapshot!;
  const windows = s.settings.quietWindows, active = activeQuietWindows(s.settings, Date.parse(s.serverTime));
  const enabled = windows.filter(window => window.enabled).length;
  return <section className="panel quiet-panel"><div className="panel-heading"><h2>안심 시간<span className="count-label">{enabled}개 사용</span></h2><Toggle label="현관문 안심 시간 전체 사용" checked={s.settings.quietEnabled} disabled={Boolean(state.pending) || !windows.length} onChange={() => void actions.saveSettings({ ...s.settings, quietEnabled: !s.settings.quietEnabled }).catch(() => {})}/></div><p className="panel-description">켜 둔 시간 중 하나에 해당하면 문 열림 알림을 남겨요.</p>
    {windows.length ? <ul className="quiet-summary">{windows.slice(0, 3).map(window => <li key={window.id}><div><b>{window.name}</b>{!window.enabled ? <Pill>꺼짐</Pill> : active.some(item => item.id === window.id) ? <span className="quiet-now"><Check size={11}/>지금</span> : null}</div><p><Clock3 size={13}/><span>{window.start} – {window.end}</span><small>{window.start > window.end ? "다음 날 · " : ""}{quietDaysLabel(window.days)}</small></p></li>)}</ul> : <div className="quiet-summary-empty"><Clock3 size={22}/><p>아직 정한 안심 시간이 없어요.</p><Link to="/settings" className="text-link">안심 시간 추가</Link></div>}
    {windows.length > 3 && <Link to="/settings" className="text-link quiet-more">안심 시간 {windows.length - 3}개 더 보기<ChevronRight size={13}/></Link>}
    <div className="quiet-footer"><span>{!windows.length ? "시간을 추가하면 알림에 적용돼요" : !s.settings.quietEnabled || !s.settings.doorAlerts || !enabled ? "문 열림 알림이 꺼져 있어요" : active.length ? "지금은 안심 시간이에요" : "시간 외에는 기록만 남겨요"}</span><Link to="/settings" className="text-link">시간 설정<ChevronRight size={13}/></Link></div></section>;
}
function SettingsMini() { return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.4"/><circle cx="7" cy="5" r="2" fill="white" stroke="currentColor" strokeWidth="1.4"/><circle cx="13" cy="10" r="2" fill="white" stroke="currentColor" strokeWidth="1.4"/><circle cx="7" cy="15" r="2" fill="white" stroke="currentColor" strokeWidth="1.4"/></svg>; }
