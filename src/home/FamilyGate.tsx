import { useRef, useState, type FormEvent } from "react";
import { ChevronRight, House, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { useHome } from "./HomeProvider";
import HomeScene from "./HomeScene";
import { Pill, SafetyNote } from "./ui";

export default function FamilyGate() {
  const { state, actions } = useHome();
  const [password, setPassword] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { await actions.unlock(password); setPassword(""); }
    catch (e) { setError((e as Error).message); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { setBusy(false); }
  }
  return <div className="zipon-app zipon-app--locked">
    <a className="skip-link" href="#family-access">본문으로 이동</a>
    <header className="gate-header"><a href="/" className="brand" aria-label="집온 홈"><span className="brand-icon"><House size={25}/></span><span>집온</span></a><span><LockKeyhole size={14}/>가족만의 공간</span></header>
    <main id="family-access" className="family-gate" tabIndex={-1}>
      <section className="gate-welcome"><p className="gate-tagline">우리 집을 잇는 작은 안심</p><h1>소중한 집의 소식,<br/>가족끼리 살펴봐요.</h1><p>문이 열리고 닫힌 시간부터<br/>가스 센서 출력과 사이렌 요청까지.</p><div className="gate-scene"><HomeScene mood="calm"/></div><div className="gate-private"><ShieldCheck size={17}/><span>비밀번호 없이 집의 기록이나 기기를 볼 수 없어요.</span></div></section>
      <section className="panel gate-card" aria-labelledby="gate-title"><span className="gate-lock"><LockKeyhole size={25} strokeWidth={1.5}/></span><h2 id="gate-title">우리 가족 공간 열기</h2><p className="gate-description">가족 비밀번호를 입력해 주세요.<br/>공간을 닫아도 저장한 기록과 설정은 남아요.</p>
        {state.accessError && <p className="field-error" role="alert">{state.accessError}</p>}
        {state.configured === false && <div className="gate-setup" role="status"><b>가족 비밀번호 설정이 필요해요</b><p>소유자가 설정 &gt; 환경 변수에서 가족 비밀번호(ADMIN_TOKEN)를 설정하면 이용할 수 있어요. 비밀번호가 없을 때는 가족 기록을 열지 않아요.</p></div>}
        <form className="gate-form" onSubmit={submit}><label className="field-label" htmlFor="family-password">가족 비밀번호 *</label><input id="family-password" name="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" maxLength={200} placeholder="비밀번호를 입력해 주세요" aria-invalid={Boolean(error)} aria-describedby={error ? "family-error" : undefined}/>{error && <p id="family-error" ref={errorRef} tabIndex={-1} className="field-error" role="alert">{error}</p>}<button type="submit" className="primary-button" disabled={busy || state.configured !== true}>{busy ? "가족 공간 여는 중…" : state.configured === null && !state.accessError ? "연결 확인 중…" : "가족 공간 열기"}<ChevronRight size={16}/></button></form>
        {(state.configured !== true || state.accessError) && <button className="text-button gate-recheck" type="button" onClick={() => void actions.checkAccess()}><RefreshCw size={13}/>설정 상태 다시 확인</button>}
        <div className="gate-limit"><Pill tone="warning">사용 전 확인</Pill><p>앱 종료·잠금 중 비상 알림은 아직 없어요. USB 연결 코드와 설치 안내는 가족 공간의 기기 관리에서 받을 수 있어요.</p></div>
      </section>
    </main>
    <div className="gate-footer"><SafetyNote/></div>
  </div>;
}
