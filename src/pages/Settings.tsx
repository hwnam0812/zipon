import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bell, BellRing, Check, Clock3, LockKeyhole, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import { LoadingState, PageHeading, Pill, SafetyNote, SavedMark, Toggle, UnavailableFeature, useUnsavedChanges } from "../home/ui";
import { maxQuietWindows, validateHomeSettings, type HomeSettings, type QuietWindow } from "../lib/home-model";

type NotificationSettings = Pick<HomeSettings, "quietEnabled" | "quietWindows" | "doorAlerts" | "gasAlerts">;
function notificationSettings(settings: HomeSettings): NotificationSettings {
  return { quietEnabled: settings.quietEnabled, quietWindows: settings.quietWindows, doorAlerts: settings.doorAlerts, gasAlerts: settings.gasAlerts };
}

export default function Settings() {
  const { state } = useHome();
  if (!state.snapshot) return <LoadingState/>;
  return <><PageHeading title="우리 집 알림 설정" description="꼭 살펴봐야 할 시간에, 필요한 소식만 알려드려요." aside={<Pill tone="positive">한국 시간 기준</Pill>}/><SettingsForm initial={state.snapshot.settings}/><SafetyNote/></>;
}
function SettingsForm({ initial }: { initial: HomeSettings }) {
  const { state, actions } = useHome();
  const [draft, setDraft] = useState(() => structuredClone(notificationSettings(initial)));
  const [saved, setSaved] = useState(() => JSON.stringify(notificationSettings(initial)));
  const [removed, setRemoved] = useState<{ window: QuietWindow; index: number } | null>(null);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dirty = JSON.stringify(draft) !== saved;
  const remote = JSON.stringify(notificationSettings(state.snapshot?.settings ?? initial));
  useEffect(() => {
    if (!dirty && remote !== saved) { setDraft(JSON.parse(remote) as NotificationSettings); setSaved(remote); }
  }, [remote, saved, dirty]);
  useUnsavedChanges(dirty);
  const saving = state.pending === "settings";
  const change = <K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]) => setDraft(old => ({ ...old, [key]: value }));
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
    const checked = validateHomeSettings({ ...state.snapshot!.settings, ...draft });
    if (!checked.value) { setError(checked.error ?? "설정을 확인해 주세요."); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    setError("");
    try {
      await actions.saveSettings(checked.value);
      const next = notificationSettings(checked.value);
      setDraft(next); setSaved(JSON.stringify(next)); setRemoved(null);
    }
    catch (err) { setError((err as Error).message); requestAnimationFrame(() => errorRef.current?.focus()); }
  }
  return <div className="settings-layout"><form className="settings-main" onSubmit={save} autoComplete="off"><fieldset className="settings-form-fields" disabled={saving}><legend className="sr-only">감지 알림 설정</legend>
    <section className="panel settings-card"><div className="panel-heading"><h2>현관문 안심 시간</h2><Toggle checked={draft.quietEnabled} onChange={() => change("quietEnabled", !draft.quietEnabled)} label="안심 시간 전체 사용"/></div>
      <p className="settings-intro">정해 둔 시간에 문이 열리면 감지 알림을 남겨요.<br/>시간은 여러 개 정할 수 있고, 시간 밖의 움직임도 기록에 남아요.</p>
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
      <p className="field-help">한국 시간 기준이에요. 자정을 넘으면 시작 요일을 선택해 주세요. 시간이 겹쳐도 같은 문 열림 알림은 한 번만 남아요.</p>
    </section>
    <section className="panel settings-card"><h2>감지 알림</h2><p className="settings-intro">기록·앱 알림·보드 자동 반응은 서로 달라요.</p><div className="setting-row"><div><h3>가스 출력 이상 알림</h3><p>직접 정한 실습 기준의 출력 상승을 보드가 보고하면 알림을 남겨요. 화재·누출 판정이 아니에요. 감시 시작과 보드 자동 반응 설정은 기기 관리에서 해요.</p></div><Toggle label="가스 출력 이상 앱 알림" checked={draft.gasAlerts} onChange={() => change("gasAlerts", !draft.gasAlerts)}/></div><div className="setting-row"><div><h3>안심 시간의 현관문 열림 알림</h3><p>위에서 정한 시간과 요일에만 앱 알림을 남겨요. 문 동작의 LED·부저 반응은 안심 시간과 별개예요.</p></div><Toggle checked={draft.doorAlerts} onChange={() => change("doorAlerts", !draft.doorAlerts)} label="안심 시간 현관문 열림 알림"/></div></section>
    <section className="panel settings-card"><div className="panel-heading"><h2>이 기기에서 알림 받기</h2><BellRing size={20} color="#7b9a70" strokeWidth={1.6}/></div><div className="setting-row"><div><h3>브라우저 알림</h3><p>이 화면이 열려 있는 동안 새 감지 소식을 띄워요.</p></div><Toggle checked={state.browserEnabled && state.permission === "granted"} disabled={state.permission === "unsupported"} onChange={() => void actions.browserNotifications().catch(() => actions.notify("알림 권한을 확인하지 못했어요. 화면 안 알림을 확인해 주세요.", "error"))} label="이 기기 브라우저 알림"/></div><div className="notification-support">{state.permission === "unsupported" ? "이 브라우저는 별도 알림을 지원하지 않아요. 오른쪽 위 종 모양에서 감지 알림을 확인해 주세요." : state.permission === "denied" ? "브라우저 알림이 차단되어 있어요. 기기의 브라우저 설정에서 이 사이트의 알림을 허용해 주세요. 화면 안 알림은 계속 남아요." : state.browserEnabled ? <><Check size={13} className="inline mr-1"/>이 브라우저에서 알림을 켰어요. 절전 상태나 기기 설정에 따라 늦어질 수 있어요.</> : "알림을 켜면 브라우저가 허용 여부를 물어봐요. 이 설정은 현재 사용 중인 기기에만 적용돼요."}</div></section>
    {error && <p ref={errorRef} tabIndex={-1} className="field-error" role="alert">{error}</p>}
    <div className="settings-savebar"><SavedMark/><button className="primary-button" type="submit" disabled={!dirty || state.pending === "settings"}><Save size={15}/>{state.pending === "settings" ? "저장 중…" : "설정 저장"}</button></div>
  </fieldset></form><aside className="settings-sidebar"><div className="settings-note"><UnavailableFeature title="앱 종료·잠금 중 비상 알림">문자·전화·화면을 닫은 뒤의 알림은 연결되지 않았어요. 현재는 화면 안 알림과 열린 화면의 브라우저 알림만 지원해요. 안전을 이 알림에만 맡기지 말아 주세요.</UnavailableFeature></div><div className="panel privacy-card"><h3><LockKeyhole size={15}/>가족의 일상은 가족만</h3><p>알림 시간과 기록은 가족 공간에 함께 저장돼요. 가족 비밀번호를 아는 사람만 확인하고 제어할 수 있어요.</p></div><div className="panel privacy-card"><h3><Bell size={15}/>알림을 끄더라도</h3><p>센서가 보낸 감지 기록은 계속 남아요. 화면 오른쪽 위의 종 모양에서 최근 알림을 다시 확인할 수 있어요.</p></div></aside></div>;
}
