import { useEffect, useMemo, useState } from "react";
import { CircleAlert, LoaderCircle, Siren, Square } from "lucide-react";
import { useHome } from "./HomeProvider";
import { Modal, Pill } from "./ui";

export default function SirenControl() {
  const { state, actions } = useHome();
  const [confirming, setConfirming] = useState(false), [now, setNow] = useState(Date.now());
  const snapshot = state.snapshot;
  const offset = useMemo(() => snapshot ? Date.parse(snapshot.serverTime) - Date.now() : 0, [snapshot?.serverTime]);
  const command = snapshot?.command;
  const active = Boolean(command && ["pending", "acknowledged"].includes(command.status));
  const running = command?.action === "start" && command.status === "acknowledged";
  useEffect(() => { if (!active) return; setNow(Date.now()); const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, [active, command?.id]);
  if (!snapshot) return null;
  const remaining = running && command?.started_at ? Math.max(0, Math.ceil((Date.parse(command.started_at) + command.seconds * 1000 - now - offset) / 1000)) : 0;
  const online = snapshot.online && !state.error;
  const waitingStop = command?.action === "stop" && active;
  async function start() { try { await actions.siren("start"); setConfirming(false); } catch { /* The saved request is not presented as successful on failure. */ } }
  let note = "한 번 더 확인한 뒤 기기에 사이렌을 요청해요.";
  if (!online) note = "기기가 연결되어야 집에 신호를 보낼 수 있어요.";
  if (command?.status === "expired") note = "기기 응답이 없어 실행 여부를 확인하지 못했어요.";
  if (command?.status === "completed") note = "기기에서 중지 응답을 받았어요. 실제 소리는 현장에서 확인해 주세요.";
  if (command?.status === "cancelled") note = "요청이 취소됐어요. 이미 켜진 부저의 중지는 보장하지 않아요.";
  if (active) note = waitingStop ? "기기의 중지 응답을 기다리고 있어요." : running ? remaining > 0 ? "기기에서 실행 응답을 받았어요. 실제 소리는 현장에서 확인해 주세요." : "예정 시간이 지났어요. 중지 응답을 기다려요." : "아직 기기의 실행 응답을 받지 못했어요.";
  return <section className={`panel siren-panel ${active ? "siren-panel--active" : ""}`} aria-label="사이렌 제어">
    <div className="panel-heading"><h2>가족에게 신호 보내기</h2><Pill tone={active ? "warning" : "neutral"}>{active ? waitingStop ? "중지 요청 대기" : running ? "실행 응답 수신" : "요청 대기" : !online ? "연결 대기" : "원격 제어"}</Pill></div>
    <p className="panel-description">연락이 닿지 않을 때, 집에 소리로 알려요.</p>
    <div className="siren-visual" aria-hidden="true"><div className="siren-ring"><div className="siren-core">{running ? <span className="siren-count">{remaining}<small>초</small></span> : active ? <LoaderCircle size={31} className="loading-spin"/> : <Siren size={36} strokeWidth={1.5}/>}</div></div><span className="sound-tick tick-one"/><span className="sound-tick tick-two"/></div>
    <button type="button" className="siren-button" disabled={state.pending === "siren" || (active ? waitingStop : !online)} onClick={active ? () => void actions.siren("stop").catch(() => {}) : () => setConfirming(true)}>{state.pending === "siren" ? <LoaderCircle size={16} className="loading-spin"/> : active ? <Square size={14} fill="currentColor"/> : <Siren size={17}/>}<span>{state.pending === "siren" ? "요청 보내는 중…" : active ? waitingStop ? "중지 전달 중…" : "사이렌 멈추기" : "사이렌 울리기"}</span>{!active && <small>{snapshot.settings.sirenSeconds}초</small>}</button>
    <p className={`siren-note ${command?.status === "expired" ? "siren-note--error" : ""}`} aria-live="polite">{note}</p>
    {command?.status === "expired" && snapshot.device.paired && <button type="button" className="text-button siren-stop-retry" disabled={Boolean(state.pending)} onClick={() => void actions.siren("stop").catch(() => {})}>중지 요청 다시 보내기</button>}
    <Modal open={confirming} onClose={() => setConfirming(false)} title="사이렌을 요청할까요?"><div className="siren-confirm-icon"><Siren size={35} strokeWidth={1.5}/></div><p className="confirm-copy">집에 설치된 부저에 <b>{snapshot.settings.sirenSeconds}초 동안</b> 신호를 보내요.<br/>기기의 실행 응답 전에는 작동 여부를 알 수 없어요.</p><div className="inline-warning"><CircleAlert size={17}/><p>갑작스러운 소리에 자녀나 강아지가 놀랄 수 있어요. 반복해서 울리지 않도록 주의해 주세요.</p></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setConfirming(false)}>취소</button><button type="button" className="siren-button" onClick={() => void start()} disabled={state.pending === "siren"}><Siren size={16}/>{state.pending === "siren" ? "요청 보내는 중…" : "집에 사이렌 요청"}</button></div></Modal>
  </section>;
}
