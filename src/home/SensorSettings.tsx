import { useEffect, useRef, useState, type FormEvent } from "react";
import { Crosshair, Save } from "lucide-react";
import { useHome } from "./HomeProvider";
import { Pill, Toggle, UnsavedChangesDialog } from "./ui";
import { validateHomeSettings, type HomeSettings } from "../lib/home-model";

const sectionKeys = {
  basic: ["homeName", "doorAlerts", "gasAlerts", "sirenSeconds"],
  door: ["closedDistance", "doorTolerance", "doorCalibrated", "doorConfirmSeconds", "doorSignals"],
  gas: ["gasWarmupConfirmed", "gasBaselineAdc", "gasRiseAdc", "gasSustainedSeconds"],
} satisfies Record<string, (keyof HomeSettings)[]>;
export type SetupSection = keyof typeof sectionKeys;
const pick = (settings: HomeSettings, section: SetupSection) => Object.fromEntries(sectionKeys[section].map(key => [key, settings[key]]));

export default function SensorSettings({ section = "basic" }: { section?: SetupSection }) {
  const { state, actions } = useHome(), s = state.snapshot!;
  const [draft, setDraft] = useState(() => structuredClone(s.settings));
  const [saved, setSaved] = useState(() => JSON.stringify(pick(s.settings, section)));
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dirty = JSON.stringify(pick(draft, section)) !== saved, remote = JSON.stringify(pick(s.settings, section));
  const board = s.sensor.board, fresh = s.online && !state.error && Boolean(board);
  const canUseGas = fresh && s.sensor.gasAdc !== null && s.sensor.gasAdc !== undefined && s.sensor.gasAdc > 0 && s.sensor.gasAdc < 1023;
  useEffect(() => { if (!dirty && remote !== saved) { setDraft(old => ({ ...old, ...JSON.parse(remote) })); setSaved(remote); } }, [dirty, remote, saved]);
  const change = <K extends keyof HomeSettings>(key: K, value: HomeSettings[K]) => { setDraft(old => ({ ...old, [key]: value, ...(key === "closedDistance" ? { doorCalibrated: false } : {}) })); setError(""); };
  const number = (key: "closedDistance" | "doorTolerance" | "doorConfirmSeconds" | "gasRiseAdc" | "gasSustainedSeconds", value: string) => change(key, value === "" ? Number.NaN : Number(value));
  const fail = (message: string) => { setError(message); requestAnimationFrame(() => errorRef.current?.focus()); };
  function reset() { setDraft(structuredClone(s.settings)); setSaved(remote); setError(""); }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (dirty && remote !== saved) { fail("다른 화면에서 이 설정이 바뀌었어요. 수정 취소 후 다시 확인해 주세요."); return; }
    const checked = validateHomeSettings({ ...s.settings, ...pick(draft, section) });
    if (!checked.value) { fail(checked.error!); return; }
    setError("");
    try { await actions.saveSettings(checked.value); setDraft(checked.value); setSaved(JSON.stringify(pick(checked.value, section))); }
    catch (error) { fail((error as Error).message); }
  }
  return <section className="panel sensor-settings" id="sensor-settings">
    <div className="panel-heading"><h2>{{ basic: "기본 설정", door: "문 기준 확인", gas: "가스 기준 확인" }[section]}</h2>{section !== "basic" && <Pill>이전 연결</Pill>}</div>
    <form onSubmit={save} autoComplete="off" noValidate><fieldset disabled={Boolean(state.pending)}><legend className="sr-only">{{ basic: "기본 설정", door: "문 기준 확인", gas: "가스 기준 확인" }[section]}</legend>
      {section === "basic" && <>
        <label className="field-label" htmlFor="home-name">집 이름 *</label><input id="home-name" name="homeName" required maxLength={20} value={draft.homeName} onChange={e => change("homeName", e.target.value)}/>
        <div className="setting-row"><div><h3>문 열림 알림</h3><p>안심 시간에만 알려줘요.</p></div><Toggle label="안심 시간 현관문 열림 알림" checked={draft.doorAlerts} onChange={() => change("doorAlerts", !draft.doorAlerts)}/></div>
        <div className="setting-row"><div><h3>가스 출력 알림</h3><p>화재·누출 판정이 아니에요.</p></div><Toggle label="가스 출력 이상 앱 알림" checked={draft.gasAlerts} onChange={() => change("gasAlerts", !draft.gasAlerts)}/></div>
        <div className="setting-row"><div><h3>이 기기 브라우저 알림</h3><p>앱을 열어 둔 동안만 받아요.</p></div><Toggle label="이 기기 브라우저 알림" checked={state.browserEnabled && state.permission === "granted"} disabled={state.permission === "unsupported"} onChange={() => void actions.browserNotifications().catch(() => actions.notify("브라우저의 알림 권한을 확인해 주세요.", "error"))}/></div>
        {state.permission === "denied" && <p className="field-help">알림이 차단되어 있어요. 브라우저 설정에서 허용해 주세요.</p>}
        <details className="settings-help"><summary>고급 설정</summary><label htmlFor="siren-seconds" className="field-label">수동 켜기 시간</label><select id="siren-seconds" name="sirenSeconds" value={draft.sirenSeconds} onChange={e => change("sirenSeconds", Number(e.target.value))}><option value={5}>5초</option><option value={10}>10초</option><option value={15}>15초</option></select></details>
      </>}
      {section === "door" && <>
        <p className="settings-step-hint">문을 닫고 거리를 확인해 주세요.</p>
        <div className="calibration-reading">현재 거리 <b>{fresh && s.sensor.distance !== null ? `${s.sensor.distance.toFixed(1)} cm` : "측정 전"}</b><button type="button" className="secondary-button" disabled={!fresh || s.sensor.distance === null || s.sensor.distance > 390} onClick={() => setDraft(old => ({ ...old, closedDistance: Math.round(s.sensor.distance! * 10) / 10, doorCalibrated: false }))}><Crosshair size={15}/>현재 거리 넣기</button></div>
        <label className="field-label" htmlFor="sensor-closedDistance">문이 닫혔을 때 거리 (cm) *</label><input id="sensor-closedDistance" name="closedDistance" type="number" min={2} max={390} step={.1} value={Number.isNaN(draft.closedDistance) ? "" : draft.closedDistance} onChange={e => number("closedDistance", e.target.value)}/>
        <label className="checkbox-label"><input type="checkbox" name="doorCalibrated" checked={draft.doorCalibrated} onChange={e => change("doorCalibrated", e.target.checked)}/><span>문을 실제로 닫고 거리 기준을 확인했어요.</span></label>
        <details className="settings-help"><summary>고급 설정</summary><div className="advanced-fields">{[
          { key: "doorTolerance" as const, label: "문 열림 판단 거리 차이 (cm)", min: 2, max: 100, step: 0.1 },
          { key: "doorConfirmSeconds" as const, label: "문 상태 확인 지속 시간 (초)", min: 1, max: 5, step: 1 },
        ].map(field => <label htmlFor={`sensor-${field.key}`} key={field.key}><span className="field-label">{field.label} *</span><input id={`sensor-${field.key}`} name={field.key} type="number" required min={field.min} max={field.max} step={field.step} value={Number.isNaN(draft[field.key]) ? "" : draft[field.key]} onChange={e => number(field.key, e.target.value)}/></label>)}</div><div className="setting-row"><div><h3>문 동작 자동 반응</h3><p>LED 0.5초 · 부저 0.2초. 안심 시간과 별개예요.</p></div><Toggle label="문 동작 자동 LED·부저" checked={draft.doorSignals} onChange={() => change("doorSignals", !draft.doorSignals)}/></div></details>
      </>}
      {section === "gas" && <>
        <p className="settings-step-hint">예열과 안정된 출력을 직접 확인해 주세요.</p><p className="inline-warning">원시 출력의 실습용 기준이에요. 화재·누출을 판단하지 않아요.</p>
        <div className="calibration-reading">최근 ADC <b>{canUseGas ? s.sensor.gasAdc : "기준 사용 불가"}</b><button type="button" className="secondary-button" disabled={!canUseGas} onClick={() => change("gasBaselineAdc", s.sensor.gasAdc!)}>현재 ADC를 기준 칸에 넣기</button></div>
        <label htmlFor="gas-baseline" className="field-label">직접 확인한 기준 ADC</label><input id="gas-baseline" name="gasBaselineAdc" type="number" min={1} max={1022} step={1} value={draft.gasBaselineAdc ?? ""} onChange={e => change("gasBaselineAdc", e.target.value === "" ? null : Number(e.target.value))}/>
        <label className="checkbox-label"><input type="checkbox" name="gasWarmupConfirmed" checked={draft.gasWarmupConfirmed} onChange={e => change("gasWarmupConfirmed", e.target.checked)}/><span>제조사 안내의 예열과 기준 출력을 직접 확인했어요.</span></label>
        <details className="settings-help"><summary>고급 설정</summary><div className="advanced-fields"><label htmlFor="gas-rise"><span className="field-label">기준에서 상승 폭 (ADC) *</span><input id="gas-rise" name="gasRiseAdc" type="number" min={1} max={1022} step={1} value={Number.isNaN(draft.gasRiseAdc) ? "" : draft.gasRiseAdc} onChange={e => number("gasRiseAdc", e.target.value)}/></label><label htmlFor="gas-hold"><span className="field-label">출력 상승 지속 시간 (초) *</span><input id="gas-hold" name="gasSustainedSeconds" type="number" min={5} max={60} step={1} value={Number.isNaN(draft.gasSustainedSeconds) ? "" : draft.gasSustainedSeconds} onChange={e => number("gasSustainedSeconds", e.target.value)}/></label></div><p className="field-help">기준 ADC + 상승 폭으로 비교해요. 복귀는 기준 ADC + 상승 폭의 절반 미만이 같은 시간 이어질 때예요. 초기 입력값은 검증된 안전 기준이 아니에요. 0·측정 실패는 경보 해제가 아니에요. 가스를 방출해 시험하지 마세요.</p></details>
        <p className="field-help">저장 후 기기 관리에서 감시를 따로 시작해요.</p>
      </>}
      {error && <p ref={errorRef} tabIndex={-1} className="field-error" role="alert">{error}</p>}
      <div className="settings-savebar"><span className="saved-mark" role="status">{dirty ? "수정 중" : "저장한 설정"}</span><button type="button" className="secondary-button" onClick={reset} disabled={!dirty || Boolean(state.pending)}>수정 취소</button><button type="submit" className="primary-button" disabled={!dirty || Boolean(state.pending)}><Save size={15}/>{state.pending === "settings" ? "저장 중…" : "설정 저장"}</button></div>
    </fieldset></form>
    <UnsavedChangesDialog dirty={dirty}/>
  </section>;
}
