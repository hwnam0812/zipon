import { Link } from "react-router";
import { ArrowUpRight, Cable, ChevronRight, Clock3, DoorClosed, Wifi, WifiOff } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import SirenControl from "../home/SirenControl";
import { HomeOutputControl } from "../home/OutputControl";
import SensorOverview from "../home/SensorOverview";
import { EmptyState, EventList, LoadingState, PageHeading, Pill, SafetyNote } from "../home/ui";
import { kstClock, quietDaysLabel } from "../lib/home-model";

export default function Home() {
  const { state } = useHome(), s = state.snapshot;
  if (state.loading || !s) return <><PageHeading title="우리 집 한눈에" description="센서와 연결 상태를 불러오고 있어요."/>{state.error ? <EmptyState title="우리 집 소식을 기다리고 있어요" description="연결을 확인하고 위의 ‘다시 불러오기’를 눌러 주세요." icon={WifiOff}/> : <LoadingState/>}</>;
  const online = s.online && !state.error;
  const board = s.sensor.board;
  return <>
    <PageHeading title="우리 집 한눈에"/>
    <section className="home-connection-strip" aria-label="연결 방식"><Cable size={22} aria-hidden="true"/><div><b>USB 직접 연결</b><p>현재 UNO의 연결·제어·기록</p></div><a className="primary-button" href="/streamlit/">USB 가족 공간 열기<ArrowUpRight size={16} aria-hidden="true"/></a></section>
    <div className="home-status-line"><div>{online ? <Wifi size={17} aria-hidden="true"/> : <WifiOff size={17} aria-hidden="true"/>}<b>이전 연결 · {online ? "수신 중" : "연결 대기"}</b><span>{s.sensor.lastSeen ? `마지막 수신 ${kstClock(s.sensor.lastSeen, true)}${online ? "" : " · 지난 보고"}` : "아직 받은 측정값이 없어요."}</span></div><Link to="/devices" className="text-link">기기 관리<ChevronRight size={15}/></Link></div>
    {(s.sensor.fireStatus === "risk" || board?.gasAlarm) && <p className="inline-warning home-alarm" role="alert">{board?.gasAlarm ? "가스 출력 경고" : "이전 경보 유지"} · 현재 안전을 뜻하지 않아요. 실제 상황을 직접 확인해 주세요.</p>}
    <div className="home-main-grid"><SensorOverview/><HomeOutputControl/></div>
    {s.sensor.lastSeen && !board && <SirenControl/>}
    <div className="dashboard-bottom">
      <section className="panel recent-panel"><div className="panel-heading"><h2>최근 기록</h2><Link to="/history" className="text-link">전체 보기<ChevronRight size={14}/></Link></div>{s.events.length ? <EventList events={s.events.slice(0, 3)} variant="recent"/> : <EmptyState title="아직 기록이 없어요" description="연결 후 받은 기록이 표시돼요." icon={DoorClosed}/>}</section>
      <QuietPanel/>
    </div>
    <SafetyNote/>
  </>;
}

function QuietPanel() {
  const { state } = useHome(), s = state.snapshot!;
  const windows = s.settings.quietWindows;
  const enabled = windows.filter(window => window.enabled).length;
  return <section className="panel quiet-panel"><div className="panel-heading"><h2>안심 시간</h2><Pill>{s.settings.quietEnabled ? `${enabled}개 사용` : "꺼짐"}</Pill></div>
    {windows.length ? <ul className="quiet-summary">{windows.slice(0, 2).map(window => <li key={window.id}><div><b>{window.name}</b>{!window.enabled && <Pill>꺼짐</Pill>}</div><p><Clock3 size={13} aria-hidden="true"/><span>{window.start} – {window.end}</span><small>{quietDaysLabel(window.days)}</small></p></li>)}</ul> : <p className="panel-description">설정한 시간이 없어요.</p>}
    <div className="quiet-footer"><Link to="/quiet-time" className="text-link">시간 관리<ChevronRight size={13}/></Link></div></section>;
}
