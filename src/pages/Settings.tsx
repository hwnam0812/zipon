import { useEffect, useRef, useState, type FormEvent } from "react";
import { Clock3, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import { Link, useSearchParams } from "react-router";
import SensorSettings, { type SetupSection } from "../home/SensorSettings";
import { LoadingState, PageHeading, Pill, SafetyNote, Toggle, UnsavedChangesDialog } from "../home/ui";
import { maxQuietWindows, validateHomeSettings, type HomeSettings, type QuietWindow } from "../lib/home-model";

type QuietSettings = Pick<HomeSettings, "quietEnabled" | "quietWindows">;
function quietSettings(settings: HomeSettings): QuietSettings {
  return { quietEnabled: settings.quietEnabled, quietWindows: settings.quietWindows };
}

export default function Settings() {
  const { state } = useHome();
  const [params] = useSearchParams();
  const section: SetupSection = params.get("section") === "door" ? "door" : params.get("section") === "gas" ? "gas" : "basic";
  if (!state.snapshot) return <LoadingState/>;
  return <><PageHeading title="설정"/><nav className="settings-tabs" aria-label="설정 항목">{([["basic", "기본 설정"], ["door", "문 기준 확인"], ["gas", "가스 기준 확인"]] as const).map(([id, label]) => <Link key={id} to={id === "basic" ? "/settings" : `/settings?section=${id}`} aria-current={section === id ? "page" : undefined}>{label}</Link>)}</nav><div className="settings-content"><SensorSettings key={section} section={section}/><div className="settings-shortcuts"><Link to="/quiet-time" className="text-link"><Clock3 size={16}/>안심 시간 관리</Link><Link to="/devices" className="text-link">연결·감시 관리</Link></div></div><SafetyNote/></>;
}
export function QuietTime() {
  const { state } = useHome();
  if (!state.snapshot) return <LoadingState/>;
  return <><PageHeading title="안심 시간" aside={<Pill>한국 시간 기준</Pill>}/><SettingsForm initial={state.snapshot.settings}/><SafetyNote/></>;
}
function SettingsForm({ initial }: { initial: HomeSettings }) {
  const { state, actions } = useHome();
  const [draft, setDraft] = useState(() => structuredClone(quietSettings(initial)));
  const [saved, setSaved] = useState(() => JSON.stringify(quietSettings(initial)));
  const [removed, setRemoved] = useState<{ window: QuietWindow; index: number } | null>(null);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dirty = JSON.stringify(draft) !== saved;
  const remote = JSON.stringify(quietSettings(state.snapshot?.settings ?? initial));
  useEffect(() => {
    if (!dirty && remote !== saved) { setDraft(JSON.parse(remote) as QuietSettings); setSaved(remote); }
  }, [remote, saved, dirty]);
  const saving = state.pending === "settings";
  const change = <K extends keyof QuietSettings>(key: K, value: QuietSettings[K]) => setDraft(old => ({ ...old, [key]: value }));
  const changeWindow = (id: string, next: Partial<QuietWindow>) => setDraft(old => ({ ...old, quietWindows: old.quietWindows.map(window => window.id === id ? { ...window, ...next } : window) }));
  function addWindow() {
    if (draft.quietWindows.length >= maxQuietWindows) return;
    const id = crypto.randomUUID();
    const window: QuietWindow = { id, name: `안심 시간 ${draft.quietWindows.length + 1}`, enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
    change("quietWindows", [...draft.quietWindows, window]);
    requestAnimationFrame(() => document.getElementById(`window-name-${id}`)?.focus());
  }
  function removeWindow(window: QuietWindow, index: number) {
    setRemoved({ window, index }); change("quietWindows", draft.quietWindows.filter(item => item.id !== window.id));
  }
  function undoRemove() {
    if (!removed || draft.quietWindows.length >= maxQuietWindows) return;
    const windows = [...draft.quietWindows]; windows.splice(removed.index, 0, removed.window);
    change("quietWindows", windows); setRemoved(null);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (dirty && remote !== saved) { setError("다른 화면에서 시간표가 바뀌었어요. 수정 취소 후 다시 확인해 주세요."); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    const checked = validateHomeSettings({ ...state.snapshot!.settings, ...draft });
    if (!checked.value) { setError(checked.error ?? "설정을 확인해 주세요."); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    setError("");
    try {
      await actions.saveSettings(checked.value);
      const next = quietSettings(checked.value);
      setDraft(next); setSaved(JSON.stringify(next)); setRemoved(null);
    }
    catch (err) { setError((err as Error).message); requestAnimationFrame(() => errorRef.current?.focus()); }
  }
  return <div className="settings-content"><form className="settings-main" onSubmit={save} autoComplete="off" noValidate><fieldset className="settings-form-fields" disabled={Boolean(state.pending)}><legend className="sr-only">안심 시간 설정</legend>
    <section className="panel settings-card"><div className="panel-heading"><h2>문 알림 시간</h2><Toggle checked={draft.quietEnabled} onChange={() => change("quietEnabled", !draft.quietEnabled)} label="안심 시간 전체 사용"/></div>
      <p className="settings-intro">이 시간에 문이 열리면 앱 알림을 남겨요. 보드의 자동 반응 시간표는 아니에요.</p>
      {!draft.quietEnabled && <p className="schedule-notice">전체 사용이 꺼져 있어요. 아래 시간은 저장되지만 문 열림 알림에는 적용되지 않아요.</p>}
      <div className="quiet-window-list">
        {draft.quietWindows.map((window, index) => <fieldset className="quiet-window" key={window.id}><legend className="sr-only">안심 시간 {index + 1}</legend>
          <div className="quiet-window-toolbar"><p>안심 시간 {index + 1}{!window.enabled && <Pill>꺼짐</Pill>}</p><div><Toggle label={`안심 시간 ${index + 1} 사용`} checked={window.enabled} onChange={() => changeWindow(window.id, { enabled: !window.enabled })}/><button className="icon-button" type="button" aria-label={`안심 시간 ${index + 1} 삭제`} onClick={() => removeWindow(window, index)}><Trash2 size={17}/></button></div></div>
          <label htmlFor={`window-name-${window.id}`} className="field-label">안심 시간 이름 *</label><input id={`window-name-${window.id}`} name={`window-name-${window.id}`} value={window.name} maxLength={24} required onChange={e => changeWindow(window.id, { name: e.target.value })}/>
          <div className="time-fields"><label className="time-field" htmlFor={`window-start-${window.id}`}><span className="field-label">시작 시간 *</span><input id={`window-start-${window.id}`} name={`window-start-${window.id}`} type="time" value={window.start} required onChange={e => changeWindow(window.id, { start: e.target.value })}/></label><span aria-hidden="true">–</span><label className="time-field" htmlFor={`window-end-${window.id}`}><span className="field-label">종료 시간 *{window.start > window.end && <small>다음 날</small>}</span><input id={`window-end-${window.id}`} name={`window-end-${window.id}`} type="time" value={window.end} required onChange={e => changeWindow(window.id, { end: e.target.value })}/></label></div>
          <span className="weekday-label" id={`window-days-${window.id}`}>반복 요일 *</span><div className="weekday-buttons" role="group" aria-labelledby={`window-days-${window.id}`}>{[1, 2, 3, 4, 5, 6, 0].map(day => <button type="button" key={day} aria-pressed={window.days.includes(day)} aria-label={`${["일", "월", "화", "수", "목", "금", "토"][day]}요일`} onClick={() => changeWindow(window.id, { days: window.days.includes(day) ? window.days.filter(value => value !== day) : [...window.days, day].sort((a, b) => a - b) })}>{["일", "월", "화", "수", "목", "금", "토"][day]}</button>)}</div>
          {window.start > window.end && <p className="field-help">선택한 요일에 시작해 다음 날 끝나요.</p>}
        </fieldset>)}
      </div>
      {!draft.quietWindows.length && <div className="schedule-empty"><Clock3 size={25}/><h3>아직 정한 안심 시간이 없어요</h3><p>문 열림을 살펴볼 시간을 추가해 주세요.<br/>시간이 없어도 문 기록은 계속 남아요.</p></div>}
      {removed && <div className="schedule-undo" role="status"><span>‘{removed.window.name}’을 목록에서 뺐어요. 저장하면 적용돼요.</span><button className="text-button" type="button" onClick={undoRemove} disabled={draft.quietWindows.length >= maxQuietWindows}><Undo2 size={14}/>되돌리기</button></div>}
      <div className="schedule-add"><button type="button" className="secondary-button" onClick={addWindow} disabled={draft.quietWindows.length >= maxQuietWindows}><Plus size={17}/>안심 시간 추가</button><span>{draft.quietWindows.length} / {maxQuietWindows}개</span></div>
      <details className="settings-help"><summary>시간표 도움말</summary><p className="field-help">자정을 넘으면 시작 요일을 선택해 주세요. 시간이 겹쳐도 같은 문 열림 알림은 한 번만 남아요. 알림을 꺼도 받은 문 기록은 남아요.</p></details>
    </section>
    {error && <p ref={errorRef} tabIndex={-1} className="field-error" role="alert">{error}</p>}
    <div className="settings-savebar"><span className="saved-mark" role="status">{dirty ? "수정 중" : "저장한 설정"}</span><button className="secondary-button" type="button" disabled={!dirty || Boolean(state.pending)} onClick={() => { setDraft(JSON.parse(remote) as QuietSettings); setSaved(remote); setRemoved(null); setError(""); }}>수정 취소</button><button className="primary-button" type="submit" disabled={!dirty || Boolean(state.pending)}><Save size={15}/>{saving ? "저장 중…" : "설정 저장"}</button></div>
  </fieldset></form><UnsavedChangesDialog dirty={dirty}/></div>;
}
