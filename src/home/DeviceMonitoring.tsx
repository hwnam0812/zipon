import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useHome } from "./HomeProvider";
import { Modal, Pill } from "./ui";
import { validateHomeSettings } from "../lib/home-model";

export default function DeviceMonitoring() {
  const { state, actions } = useHome(), s = state.snapshot!;
  const board = s.sensor.board, fresh = s.online && !state.error && Boolean(board);
  const [confirmed, setConfirmed] = useState(false);
  const [intent, setIntent] = useState<"start" | "stop" | null>(null);
  useEffect(() => { setConfirmed(false); setIntent(null); }, [board?.session]);
  const ready = s.settings.gasWarmupConfirmed && s.settings.gasBaselineAdc !== null;
  const selected = Boolean(s.settings.gasEnabled && board && s.settings.gasArmSession === board.session);
  const canStart = fresh && ready && confirmed && s.sensor.gasAdc != null && s.sensor.gasAdc > 0 && s.sensor.gasAdc < 1023 && !board?.gasAlarm;
  async function apply() {
    if (!intent || intent === "start" && !canStart) return;
    const checked = validateHomeSettings({ ...s.settings, gasEnabled: intent === "start", ...(intent === "start" ? { gasArmSession: board!.session } : {}) });
    if (!checked.value) { actions.notify(checked.error!, "error"); return; }
    try { await actions.saveSettings(checked.value); setIntent(null); } catch { /* Keep the confirmation open for retry. */ }
  }
  return <section className="panel sensor-settings monitoring-panel">
    <div className="panel-heading"><h2>이번 연결의 감시</h2><Pill>{selected ? "감시 설정 켜짐" : "감시 시작 전"}</Pill></div>
    <div className="board-configuration"><Pill tone={fresh && board?.configRevision === s.boardConfig.revision ? "positive" : "neutral"}>{!fresh ? "보드 설정 미확인" : board?.configRevision === s.boardConfig.revision ? "저장한 설정 적용 응답 수신" : "보드의 설정 적용 대기"}</Pill><span>실제 빛·소리는 현장에서 확인해 주세요.</span></div>
    <p className="field-help">가스 원시 출력의 실습용 감시예요. 기준 저장만으로 새 감시를 시작하지 않아요.</p>
    {!ready && <Link className="text-link" to="/settings?section=gas">가스 기준·예열 확인</Link>}
    <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>이번 연결의 예열과 안정된 기준 출력을 직접 확인했어요.</span></label>
    <div className="gas-arm-actions"><button type="button" className="primary-button" disabled={!canStart || selected || Boolean(state.pending)} onClick={() => setIntent("start")}>가스 감시 시작</button><button type="button" className="secondary-button" disabled={!s.settings.gasEnabled || Boolean(state.pending)} onClick={() => setIntent("stop")}>가스 감시 종료</button><Link className="text-link" to="/settings?section=door">문 기준 설정</Link></div>
    <details className="settings-help"><summary>감시 도움말</summary><p className="field-help">문 동작의 자동 반응은 저장한 문 기준을 따라요. 안심 시간은 앱 알림에만 적용돼요. 연결이 끊겨도 보드 전원이 남으면 이미 적용된 자동 반응은 계속될 수 있어요. 감시 종료 요청은 물리적인 전원 차단이 아니에요.</p></details>
    <Modal open={intent !== null} onClose={() => setIntent(null)} title={intent === "start" ? "이번 연결에서 가스 감시를 시작할까요?" : "가스 감시를 종료할까요?"}>
      <p className="confirm-copy">{intent === "start" ? "직접 저장한 ADC 기준을 사용해요. 화재·누출·안전 판정이 아니에요." : "이전 중계에 감시 종료 설정을 보내요. 이미 켜진 자동 출력에도 영향을 줄 수 있어요. 현장 상태를 직접 확인해 주세요."}</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setIntent(null)}>취소</button><button type="button" className="primary-button" disabled={Boolean(state.pending) || intent === "start" && !canStart} onClick={() => void apply()}>{intent === "start" ? "가스 감시 시작" : "가스 감시 종료"}</button></div>
    </Modal>
  </section>;
}
