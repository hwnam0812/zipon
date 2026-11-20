import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { Activity, Bell, Check, ChevronRight, Clock3, House, LockKeyhole, LogOut, Radio, Settings2, X } from "lucide-react";
import { useHome } from "./HomeProvider";
import FamilyGate from "./FamilyGate";
import { Modal, Pill } from "./ui";
import { kstClock, kstDay } from "../lib/home-model";

const pages = [
  { to: "/", label: "홈", icon: House },
  { to: "/history", label: "기록", icon: Clock3 },
  { to: "/devices", label: "기기 관리", icon: Radio },
  { to: "/quiet-time", label: "안심 시간", icon: Clock3 },
  { to: "/settings", label: "설정", icon: Settings2 },
  { to: "/monitor", label: "실시간", icon: Activity },
];
export default function Shell() {
  const { state, actions } = useHome(), location = useLocation();
  const [alertsOpen, setAlertsOpen] = useState(false);
  const page = pages.find(p => p.to === location.pathname) ?? { label: location.pathname === "/gas-status" ? "가스 센서 상태" : location.pathname === "/door-status" ? "문 작동 확인" : "우리 집" };
  const unread = state.snapshot?.alerts.filter(a => !a.read_at) ?? [];
  const homeName = state.snapshot?.settings.homeName ?? "우리 집";
  useEffect(() => { setAlertsOpen(false); }, [state.authenticated]);
  if (!state.authenticated) return <FamilyGate/>;
  return <div className="zipon-app">
    <a className="skip-link" href="#main-content">본문으로 이동</a>
    <aside className="sidebar">
      <Link to="/" className="brand" aria-label="집온 홈"><span className="brand-icon"><House size={25} strokeWidth={1.7}/></span><span>집온</span><span className="brand-latin">zipon</span></Link>
      <nav className="main-nav" aria-label="주 메뉴">{pages.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `nav-item${isActive ? " is-active" : ""}`}><Icon size={20} strokeWidth={1.7}/><span>{label}</span><i/></NavLink>)}</nav>
      <div className="sidebar-bottom">
        <button className="family-button" type="button" onClick={actions.leave}><span className="family-avatar">우</span><span><b>우리 가족</b><small>가족 공간 닫기</small></span><LogOut size={17}/></button>
      </div>
    </aside>
    <header className="topbar"><div className="breadcrumbs"><House size={16}/><span>{homeName}</span><ChevronRight size={13}/><span>{page.label === "우리 집" ? "대시보드" : page.label}</span></div><Link className="mobile-brand" to="/"><House size={23}/>집온</Link>
      <div className="topbar-actions"><button className="mode-label mode-label--family" type="button" onClick={actions.leave} aria-label="가족 공간 닫기"><LockKeyhole size={12}/>가족 공간<LogOut size={12}/></button><button className="icon-button notification-button" type="button" onClick={() => setAlertsOpen(true)} aria-label={`알림 ${unread.length}개`}><Bell size={20} strokeWidth={1.7}/>{unread.length > 0 && <span className="notification-dot">{unread.length > 9 ? "9+" : unread.length}</span>}</button></div>
    </header>
    <main id="main-content" className="app-main" tabIndex={-1}>
      {state.error && <div className="connection-error" role="alert"><Radio size={18}/><p>{state.error} <strong>현재 상태는 확인되지 않았어요.</strong></p><button type="button" onClick={() => void actions.refresh()}>다시 불러오기</button></div>}
      <Outlet/>
    </main>
    <nav className="mobile-nav" aria-label="모바일 주 메뉴">{pages.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "is-active" : ""}><Icon size={21} strokeWidth={1.7}/><span>{label}</span></NavLink>)}</nav>
    {state.toast && <div className={`toast toast--${state.toast.tone}`} role={state.toast.tone === "error" ? "alert" : "status"}>{state.toast.tone === "success" ? <Check size={18}/> : state.toast.tone === "error" ? <X size={18}/> : <Bell size={18}/>}<span>{state.toast.text}</span></div>}
    <Modal open={alertsOpen} onClose={() => setAlertsOpen(false)} title="우리 집 알림" className="alerts-modal"><div className="alerts-toolbar"><p>읽지 않은 알림 <b>{unread.length}</b>개</p><button type="button" className="text-button" disabled={!unread.length || state.pending === "alerts"} onClick={() => void actions.readAlerts(unread.map(a => a.id)).catch(() => {})}>모두 읽음</button></div>
      {!state.snapshot?.alerts.length ? <div className="empty-state"><Bell size={28}/><h3>새로운 감지 알림이 없어요</h3><p>안심 시간의 문 열림과 설정한 가스 출력 변화 알림이 여기에 남아요. 화재·누출을 판정하는 알림은 아니에요.</p></div> : <ol className="alerts-list">{state.snapshot.alerts.map(alert => <li key={alert.id} className={alert.read_at ? "is-read" : ""}><span className={`alert-symbol ${alert.kind === "fire_risk" || alert.kind === "gas_alert" ? "alert-symbol--fire" : ""}`}><Bell size={18}/></span><div><div className="alert-title"><h3>{alert.title}</h3>{!alert.read_at && <Pill tone="danger">새 알림</Pill>}</div><p>{alert.message}</p><time dateTime={alert.created_at}>{kstDay(alert.created_at)} {kstClock(alert.created_at)}</time>{!alert.read_at && <button className="text-button" type="button" onClick={() => void actions.readAlerts([alert.id]).catch(() => {})}>읽음으로 표시</button>}</div></li>)}</ol>}
      <p className="modal-footnote"><b>앱 종료·잠금 중 비상 알림: 구현되지 않음.</b><br/>기기가 값을 보내는 동안 감지 기록과 화면 안 알림은 계속 저장해요.</p>
    </Modal>
  </div>;
}
