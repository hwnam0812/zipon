import { useEffect, useState, type FormEvent } from "react";
import { Crosshair, Save } from "lucide-react";
import { useHome } from "./HomeProvider";
import { Pill, SavedMark, Toggle, useUnsavedChanges } from "./ui";
import { validateHomeSettings, type HomeSettings } from "../lib/home-model";

const keys = ["homeName", "closedDistance", "doorTolerance", "sirenSeconds", "doorCalibrated", "doorConfirmSeconds", "doorSignals", "gasEnabled", "gasWarmupConfirmed", "gasArmSession", "gasBaselineAdc", "gasRiseAdc", "gasSustainedSeconds"] as const;
type Calibration = Pick<HomeSettings, typeof keys[number]>;
function calibration(settings: HomeSettings): Calibration {
  return Object.fromEntries(keys.map(key => [key, settings[key]])) as Calibration;
}

export default function SensorSettings() {
  const { state, actions } = useHome(), s = state.snapshot!;
  const [draft, setDraft] = useState(() => calibration(s.settings));
  const [saved, setSaved] = useState(() => JSON.stringify(calibration(s.settings)));
  const [warmup, setWarmup] = useState(false), [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== saved, remote = JSON.stringify(calibration(s.settings));
  const board = s.sensor.board, fresh = s.online && !state.error && Boolean(board);
  const canUseGas = fresh && s.sensor.gasAdc !== null && s.sensor.gasAdc !== undefined && s.sensor.gasAdc > 0 && s.sensor.gasAdc < 1023;
  const armPrepared = Boolean(draft.gasEnabled && board && draft.gasArmSession === board.session);
  useEffect(() => { if (!dirty && remote !== saved) { setDraft(JSON.parse(remote) as Calibration); setSaved(remote); } }, [dirty, remote, saved]);
  useEffect(() => setWarmup(false), [board?.session]);
  useUnsavedChanges(dirty);
  const change = <K extends keyof Calibration>(key: K, value: Calibration[K]) => setDraft(old => ({ ...old, [key]: value }));
  const number = (key: "closedDistance" | "doorTolerance" | "doorConfirmSeconds" | "gasRiseAdc" | "gasSustainedSeconds", value: string) => change(key, value === "" ? Number.NaN : Number(value));
  async function save(e: FormEvent) {
    e.preventDefault();
    const checked = validateHomeSettings({ ...s.settings, ...draft });
    if (!checked.value) { setError(checked.error!); return; }
    setError("");
    try { await actions.saveSettings(checked.value); const next = calibration(checked.value); setDraft(next); setSaved(JSON.stringify(next)); }
    catch (error) { setError((error as Error).message); }
  }
  return <section className="panel sensor-settings" id="sensor-settings">
    <div className="panel-heading"><h2>문 거리·가스 출력 기준</h2><Pill tone="warning">실습용</Pill></div>
    <p className="panel-description">앱에 저장한 뒤 보드의 적용 응답을 확인해 주세요. 이전 센서 기록·설정은 보존해요.</p>
    <form onSubmit={save}><fieldset disabled={state.pending === "settings"}><legend className="sr-only">센서 보정과 자동 반응 설정</legend>
      <label className="field-label" htmlFor="home-name">집 이름 *</label><input id="home-name" required maxLength={20} value={draft.homeName} onChange={e => change("homeName", e.target.value)}/>
      <div className="calibration-section"><h3>현관문 거리 보정</h3><p>문을 닫은 상태에서 기준을 잡아요. 초음파 무응답은 문 열림이 아니에요. 측정 실패 후 첫 확인값은 새 기준 상태로 삼고 움직임으로 세지 않아요.</p>
        <div className="calibration-reading">최근 거리 <b>{fresh && s.sensor.distance !== null ? `${s.sensor.distance.toFixed(1)} cm` : "측정 미확인"}</b><button type="button" className="secondary-button" disabled={!fresh || s.sensor.distance === null || s.sensor.distance > 390} onClick={() => setDraft(old => ({ ...old, closedDistance: Math.round(s.sensor.distance! * 10) / 10, doorCalibrated: true }))}><Crosshair size={15}/>문이 닫힌 지금 거리로 보정</button></div>
        <div className="advanced-fields">{[
          { key: "closedDistance" as const, label: "문이 닫혔을 때 거리 (cm)", min: 2, max: 390, step: 0.1 },
          { key: "doorTolerance" as const, label: "문 열림 판단 거리 차이 (cm)", min: 2, max: 100, step: 0.1 },
          { key: "doorConfirmSeconds" as const, label: "문 상태 확인 지속 시간 (초)", min: 1, max: 5, step: 1 },
        ].map(field => <label htmlFor={`sensor-${field.key}`} key={field.key}><span className="field-label">{field.label} *</span><input id={`sensor-${field.key}`} type="number" required min={field.min} max={field.max} step={field.step} value={Number.isNaN(draft[field.key]) ? "" : draft[field.key]} onChange={e => number(field.key, e.target.value)}/></label>)}</div>
        <label className="checkbox-label"><input type="checkbox" checked={draft.doorCalibrated} onChange={e => change("doorCalibrated", e.target.checked)}/><span>문을 실제로 닫고 거리 기준을 확인했어요.</span></label>
        <div className="setting-row"><div><h3>문 동작에 LED·부저 자동 반응</h3><p>확인된 열림·닫힘 변화에 LED 0.5초, 부저 0.2초로 반응해요. 안심 시간 밖에서도 작동하며, 안심 시간은 앱 알림에만 적용해요.</p></div><Toggle label="문 동작 자동 LED·부저" checked={draft.doorSignals} onChange={() => change("doorSignals", !draft.doorSignals)}/></div>
      </div>
      <div className="calibration-section"><h3>MQ-135 실습용 출력 변화 감시</h3><p className="inline-warning">가스 농도나 화재 감도가 아니에요. 예열 후 안정된 원시 ADC를 직접 확인해 주세요. 100 ADC 상승·10초는 검증되지 않은 초기 입력값이며 안전 기준이 아니에요. 가스를 방출해 시험하지 마세요.</p>
        <div className="calibration-reading">최근 ADC <b>{canUseGas ? s.sensor.gasAdc : "기준 사용 불가"}</b><button type="button" className="secondary-button" disabled={!canUseGas} onClick={() => change("gasBaselineAdc", s.sensor.gasAdc!)}>현재 ADC를 기준 칸에 넣기</button></div>
        <div className="advanced-fields"><label htmlFor="gas-baseline"><span className="field-label">직접 확인한 기준 ADC</span><input id="gas-baseline" type="number" min={1} max={1022} step={1} value={draft.gasBaselineAdc ?? ""} placeholder="예열·안정화 후 입력" onChange={e => change("gasBaselineAdc", e.target.value === "" ? null : Number(e.target.value))}/></label>
          <label htmlFor="gas-rise"><span className="field-label">기준에서 상승 폭 (ADC) *</span><input id="gas-rise" type="number" min={1} max={1022} step={1} required value={Number.isNaN(draft.gasRiseAdc) ? "" : draft.gasRiseAdc} onChange={e => number("gasRiseAdc", e.target.value)}/></label>
          <label htmlFor="gas-hold"><span className="field-label">출력 상승 지속 시간 (초) *</span><input id="gas-hold" type="number" min={5} max={60} step={1} required value={Number.isNaN(draft.gasSustainedSeconds) ? "" : draft.gasSustainedSeconds} onChange={e => number("gasSustainedSeconds", e.target.value)}/></label></div>
        <p className="field-help">기준 ADC + 상승 폭 이상이 설정 시간 동안 이어지면 자동 반응해요. 복귀는 기준 ADC + 상승 폭의 절반(소수점 버림) 미만이 같은 시간 이어질 때예요. 끝값 0·측정 실패로 경고를 해제하지 않아요. 기준 미만도 안전을 뜻하지 않아요.</p>
        <label className="checkbox-label"><input type="checkbox" checked={warmup} onChange={e => setWarmup(e.target.checked)}/><span>제조사 예열·안정화 지침과 기준 ADC를 직접 확인했어요. 앱은 예열 완료나 안전을 판정하지 않는다는 점을 이해해요.</span></label>
        <div className="gas-arm-actions"><Pill tone={armPrepared ? "warning" : "neutral"}>{armPrepared ? dirty ? "저장하면 이번 연결에서 감시해요" : "앱 감시 설정 켜짐·보드 응답 별도 확인" : "이번 연결의 감시 시작 전"}</Pill><button type="button" className="secondary-button" disabled={!canUseGas || !warmup || draft.gasBaselineAdc === null} onClick={() => setDraft(old => ({ ...old, gasEnabled: true, gasWarmupConfirmed: true, gasArmSession: board!.session }))}>이번 연결에서 감시 켜기 준비</button><button type="button" className="text-button" disabled={!draft.gasEnabled} onClick={() => change("gasEnabled", false)}>감시 끄기 준비</button></div>
        <p className="field-help">아래 ‘기준값 저장’을 눌러야 적용돼요. USB 프로그램 재시작 뒤에는 감시를 직접 다시 켜 주세요. 보드 전원이 남으면 인터넷·프로그램이 끊겨도 이미 적용된 자동 반응은 계속될 수 있어요.</p>
      </div>
      <div className="calibration-section"><label htmlFor="siren-seconds" className="field-label">수동 LED·부저 켜기 시간</label><select id="siren-seconds" value={draft.sirenSeconds} onChange={e => change("sirenSeconds", Number(e.target.value))}><option value={5}>5초</option><option value={10}>10초</option><option value={15}>15초</option></select><p className="field-help">자동 가스 출력 경고는 해제·일시 정지 전까지 반복 패턴으로 반응해요. 위 시간은 수동 켜기에만 적용돼요.</p></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="settings-savebar"><SavedMark/><button type="submit" className="primary-button" disabled={!dirty || Boolean(state.pending)}><Save size={15}/>{state.pending === "settings" ? "저장 중…" : "기준값 저장"}</button></div>
    </fieldset></form>
  </section>;
}
