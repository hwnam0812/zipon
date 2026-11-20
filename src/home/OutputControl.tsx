import { useState } from "react";
import { CircleAlert, Lightbulb, Volume2, VolumeX } from "lucide-react";
import { useHome } from "./HomeProvider";
import { Modal, Pill } from "./ui";
import { outputCommandLabels, outputSourceLabels, type OutputAction, type OutputTarget } from "../lib/home-model";

export default function OutputControl() {
  return <OutputPanel presentation="full"/>;
}
export function HomeOutputControl() {
  return <OutputPanel presentation="home"/>;
}
function OutputPanel({ presentation }: { presentation: "home" | "full" }) {
  const { state, actions } = useHome();
  const [confirming, setConfirming] = useState<OutputAction | null>(null);
  const s = state.snapshot;
  if (!s) return null;
  const board = s.sensor.board, fresh = s.online && !state.error && Boolean(board);
  const paused = Boolean(board && (board.muteSeconds || board.buzzerOffSeconds));
  const latest = s.outputCommands?.[0];
  async function send(target: OutputTarget, action: OutputAction) {
    try { await actions.output(target, action); setConfirming(null); } catch { /* The saved request is never shown as execution. */ }
  }
  return <section className="panel output-control" aria-label="LED·부저 독립 제어">
    <div className="panel-heading"><h2>우리 집 바로 제어</h2><Pill tone={fresh ? "positive" : "neutral"}>{fresh ? "보드 응답 수신" : "연결 대기"}</Pill></div>
    <p className="panel-description">짧게 요청하고, 실제 작동은 현장에서 확인해요.</p>
    <div className="quick-output-actions">
      <button type="button" className="quick-output-button" disabled={!fresh || Boolean(state.pending) || s.outputCommands?.some(c => c.target === "led" && ["pending", "claimed"].includes(c.status))} onClick={() => void send("led", "on")}><Lightbulb size={24}/><span><b>LED 켜기</b><small>{s.settings.sirenSeconds}초 뒤 수동 요청 종료</small></span></button>
      <button type="button" className="quick-output-button quick-output-button--sound" disabled={!fresh || Boolean(state.pending) || s.outputCommands?.some(c => c.target === "buzzer" && ["pending", "claimed"].includes(c.status))} onClick={() => setConfirming("test")}><Volume2 size={24}/><span><b>부저 울리기</b><small>재확인 후 2초 시험</small></span></button>
    </div>
    <div className="quick-output-report"><span>마지막 출력 보고</span><b>{fresh ? `LED ${board?.ledOn ? "켜짐" : "꺼짐"} · 부저 ${board?.buzzerOn ? "작동" : "정지"}` : "현재 출력 미확인"}</b></div>
    {presentation === "home" && <><div className="quick-output-stop"><button type="button" className="secondary-button" disabled={!fresh || Boolean(state.pending)} onClick={() => void send("led", "off")}>수동 LED 끄기</button><button type="button" className="secondary-button" disabled={!fresh || Boolean(state.pending)} onClick={() => void send("buzzer", "off")}>수동 부저 끄기</button></div><p className="field-help">기존 중계의 끄기는 30초 동안 자동 반응을 억제해요. V4의 끄기와는 달라요.</p></>}
    <details className="output-advanced" open={presentation === "full" ? true : undefined}><summary>상세 제어·요청 상태</summary>
    <OutputChannel target="led" onActivate={action => void send("led", action)}/>
    <OutputChannel target="buzzer" onActivate={action => action === "off" ? void send("buzzer", action) : setConfirming(action)}/>
    <button type="button" className="secondary-button output-mute" disabled={!board || Boolean(state.pending) || paused && !fresh} onClick={() => void send("alarm", paused ? "resume" : "mute")}>{paused ? <Volume2 size={15}/> : <VolumeX size={15}/>}{paused ? "경고음 일시 정지 해제" : "자동 경고음 60초 쉬기"}</button>
    <p className="field-help">{fresh && board ? board.muteSeconds ? `보드 보고: 자동 경고음 ${board.muteSeconds}초 일시 정지` : board.buzzerOffSeconds ? `보드 보고: 부저 ${board.buzzerOffSeconds}초 끄기` : "자동 문·가스 반응은 수동 요청과 별개예요." : "새 응답 전에는 현재 빛·소리를 알 수 없어요."}</p>
    {latest && <p className={`output-request ${["expired", "rejected"].includes(latest.status) ? "is-error" : ""}`} aria-live="polite">최근 요청: {outputCommandLabels[latest.status]}</p>}
    <p className="output-disclaimer">끄기는 30초 뒤 자동 반응으로 돌아가요. 수동 켜기는 최대 15초, USB 연결 신호가 3초 끊겨도 종료해요. 자동 경고음 일시 정지 중에도 수동 시험은 울릴 수 있어요. 빛·소리는 현장에서 확인해 주세요.</p>
    </details>
    {presentation === "home" && <p className="field-help" aria-live="polite">{latest ? `최근 요청: ${outputCommandLabels[latest.status]} · 실행 응답과 현재 출력 보고는 별개예요.` : "연결 후 사용할 수 있어요. 실행 응답은 실제 빛·소리의 증거가 아니에요."}</p>}
    <Modal open={confirming !== null} onClose={() => setConfirming(null)} title="부저를 울릴까요?">
      <p className="confirm-copy">작은 수동 피에조 부저에 <b>{confirming === "test" ? 2 : s.settings.sirenSeconds}초</b> 소리를 요청해요. 보드 실행 응답은 실제 소리의 증거가 아니에요.</p>
      <div className="inline-warning"><CircleAlert size={18}/><p>가족과 반려견이 놀라지 않도록 현장에 먼저 알려 주세요.</p></div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setConfirming(null)}>취소</button><button type="button" className="primary-button" disabled={Boolean(state.pending) || !fresh} onClick={() => confirming && void send("buzzer", confirming)}>부저 울리기 요청</button></div>
    </Modal>
  </section>;
}

function OutputChannel({ target, onActivate }: { target: "led" | "buzzer"; onActivate: (action: "on" | "off" | "test") => void }) {
  const { state } = useHome();
  const s = state.snapshot!, board = s.sensor.board;
  const fresh = s.online && !state.error && Boolean(board);
  const name = target === "led" ? "LED" : "부저", Icon = target === "led" ? Lightbulb : Volume2;
  const on = target === "led" ? board?.ledOn : board?.buzzerOn;
  const source = target === "led" ? board?.ledSource : board?.buzzerSource;
  const command = s.outputCommands?.find(item => item.target === target);
  const waiting = Boolean(command && ["pending", "claimed"].includes(command.status));
  return <div className="output-channel">
    <div className="output-channel-status"><Icon size={18}/><b>{name}</b><span className={fresh && on ? "is-on" : ""}>{!fresh ? "현재 출력 미확인" : `${on ? "켜짐" : "꺼짐"} · ${source ? outputSourceLabels[source] : "미확인"}`}</span></div>
    <div className="output-buttons">{(["on", "off", "test"] as const).map(action => <button type="button" className={action === "on" ? "output-button output-button--on" : "output-button"} key={action} aria-label={`${name} ${{ on: `켜기 ${s.settings.sirenSeconds}초`, off: "끄기 30초", test: "시험 2초" }[action]}`} disabled={Boolean(state.pending) || (action === "off" ? !board : !fresh || waiting)} onClick={() => onActivate(action)}>{{ on: `켜기 ${s.settings.sirenSeconds}초`, off: "끄기 30초", test: "시험 2초" }[action]}</button>)}</div>
    {command && <small className="output-channel-request">{outputCommandLabels[command.status]}</small>}
  </div>;
}
