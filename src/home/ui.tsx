import { useEffect, useId, useRef, type ReactNode } from "react";
import { Check, CheckCheck, Clock3, DoorClosed, DoorOpen, Flame, Lightbulb, LoaderCircle, ShieldCheck, Siren, Wind, X, type LucideIcon } from "lucide-react";
import { kstClock, type HomeEvent } from "../lib/home-model";

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "positive" | "neutral" | "warning" | "danger" | "blue" }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}
export function IconBadge({ icon: Icon, tone = "green" }: { icon: LucideIcon; tone?: "green" | "orange" | "blue" | "red" | "gray" }) {
  return <span className={`icon-badge icon-badge--${tone}`}><Icon size={20} strokeWidth={1.7} aria-hidden="true"/></span>;
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={onChange} disabled={disabled}><span>{checked && <Check size={10}/>}</span></button>;
}
export function PageHeading({ title, description, aside }: { title: string; description: string; aside?: ReactNode }) {
  return <div className="page-heading"><div><p className="page-eyebrow">소중한 일상이 머무는 곳</p><h1>{title}</h1><p className="page-description">{description}</p></div>{aside}</div>;
}
export function Modal({ open, onClose, title, children, className = "" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (open) { const old = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = old; }; }
  }, [open]);
  return <dialog ref={ref} aria-labelledby={id} className={`modal ${className}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-header"><h2 id={id}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="닫기"><X size={20}/></button></div>{children}
  </dialog>;
}
export function LoadingState() { return <div className="loading-state" role="status"><LoaderCircle size={24} className="loading-spin"/><p>우리 집 소식을 불러오고 있어요.</p></div>; }
export function EmptyState({ title, description, icon: Icon = Clock3 }: { title: string; description: string; icon?: LucideIcon }) {
  return <div className="empty-state"><Icon size={28} strokeWidth={1.4}/><h3>{title}</h3><p>{description}</p></div>;
}
export function EventList({ events, variant = "history" }: { events: HomeEvent[]; variant?: "history" | "recent" }) {
  return <ol className={`event-list event-list--${variant}`}>{events.map(event => {
    const Icon = event.kind === "door_open" ? DoorOpen : event.kind === "door_closed" ? DoorClosed : event.kind.startsWith("gas") ? Wind : event.kind.startsWith("fire") ? Flame : event.kind.startsWith("output") || event.kind === "sensor_settings" ? Lightbulb : Siren;
    const tone = event.kind === "fire_risk" || event.kind === "gas_alert" ? "red" : event.kind.startsWith("siren") || event.kind.startsWith("output") ? "orange" : "green";
    return <li key={event.id}><time dateTime={event.created_at}>{kstClock(event.created_at)}<span>{kstClock(event.created_at, true).slice(-2)}초</span></time><IconBadge icon={Icon} tone={tone}/><div className="event-copy"><p>{event.title}</p><span className="event-detail">{event.detail || (event.kind.startsWith("door") ? "현관 초음파 센서에서 감지했어요." : "우리 집 기기의 감지 기록이에요.")}</span></div><Pill tone={event.emergency ? "danger" : "neutral"}>{event.emergency ? "비상 알림" : event.kind === "door_open" ? "열림" : event.kind === "door_closed" ? "닫힘" : event.kind === "fire_risk" ? "주의" : "기록"}</Pill></li>;
  })}</ol>;
}
export function SafetyNote() {
  return <footer className="safety-note"><ShieldCheck size={14} aria-hidden="true"/><p>집온은 보조 모니터링 도구예요. MQ-135 출력으로 가스 누출·화재·안전을 판단하지 않아요.<br className="mobile-break"/> 인증된 독립 경보기를 사용하고 가족과 반려견의 안전을 직접 확인해 주세요.</p></footer>;
}
export function SavedMark() { return <span className="saved-mark"><CheckCheck size={15}/>저장한 설정은 다시 열어도 유지돼요</span>; }
export function UnavailableFeature({ title, children }: { title: string; children: ReactNode }) {
  return <section className="unavailable-feature"><div><h3>{title}</h3><Pill tone="warning">구현되지 않음</Pill></div><p>{children}</p></section>;
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
