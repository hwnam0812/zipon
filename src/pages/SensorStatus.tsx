import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, CircleHelp, DoorClosed, Wind } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import { IconBadge, LoadingState, PageHeading, Pill, SafetyNote } from "../home/ui";
import { compareDoorDistance, gasStatusLabels, kstClock } from "../lib/home-model";

function StatusSheet({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <><Link to="/" className="text-link back-home"><ArrowLeft size={16}/>우리 집으로</Link><PageHeading title={title} description={description}/><div className="status-detail-layout">{children}</div><SafetyNote/></>;
}

export function GasStatus() {
  const { state } = useHome(), s = state.snapshot;
  if (!s) return <LoadingState/>;
  const fresh = s.online && !state.error;
  const measured = s.sensor.gasSensor === "MQ-135" && s.sensor.gasAdc != null;
  const endpoint = measured && (s.sensor.gasAdc === 0 || s.sensor.gasAdc === 1023);
  const board = s.sensor.board;
  return <StatusSheet title="가스 센서 상태" description="측정한 원시값과 판단할 수 없는 위험도를 구분해요.">
    <section className="panel status-detail-primary"><IconBadge icon={Wind} tone="orange"/><p className="status-kicker">화재 위험</p><h2>판단 불가</h2><p className="status-explanation">농도 미측정 · 화재 위험 판단 불가<br/>원시 출력만으로 화재·누출·안전을 판단할 수 없어요.</p>
      <div className="unapplied-threshold"><span>요청한 비교 기준</span><b>5,000 <small>ppm 초과</small></b><Pill tone="warning">미적용</Pill><p>ppm 환산과 가스별 보정이 없어 이 기준과 비교하지 않아요. 5,000ppm을 검증된 화재 기준으로 제시하지 않아요.</p></div>
      <p className="field-help" role={fresh && (!measured || endpoint) ? "status" : undefined}>{!fresh ? "새 측정이 없어 현재 출력은 확인 불가예요." : !measured ? "측정 실패 · MQ-135용 코드와 배선·전원을 확인해 주세요." : endpoint ? "범위 끝값 · 배선·전원·출력 범위를 확인해 주세요. 이 값은 안전 판정이 아니에요." : "가스 누출 여부는 판단하지 않아요."}</p>
      {s.sensor.fireStatus === "risk" && <p className="inline-warning">이전 경보 유지 · 지금 센서의 값으로 확인하거나 해제하지 않아요. 실제 상황을 직접 확인해 주세요.</p>}
    </section>
    <div className="status-detail-secondary"><section className="panel measurement-panel"><div className="panel-heading"><h2>실제로 받은 값</h2><Pill>{fresh ? "새 측정" : "현재 확인 불가"}</Pill></div><p className="measurement-number">{fresh && measured ? s.sensor.gasAdc : "—"}<span>ADC</span></p><progress value={fresh && measured ? s.sensor.gasAdc! : 0} max={1023} aria-label="가스 원시 출력 0에서 1023. 위험도 게이지가 아니에요."/><div className="measurement-scale"><span>0 ADC</span><span>1023 ADC</span></div><dl className="measurement-facts"><div><dt>근사 전압</dt><dd>{fresh && measured && s.sensor.gasVoltageV != null ? `${s.sensor.gasVoltageV.toFixed(2)} V` : "확인 불가"}</dd></div><div><dt>출력 감시</dt><dd>{fresh && board ? gasStatusLabels[board.gasStatus] : "현재 확인 불가"}</dd></div><div><dt>경고 기록</dt><dd>{board?.gasAlarm ? "출력 경고 유지 · 현장 확인 필요" : "화재 판단과 관계없음"}</dd></div><div><dt>마지막 수신</dt><dd>{s.sensor.lastSeen ? `${kstClock(s.sensor.lastSeen, true)}${fresh ? "" : " · 지난 보고"}` : "아직 없어요"}</dd></div></dl></section><section className="status-help"><CircleHelp size={20}/><div><h2>출력 경고와 화재 판단은 달라요</h2><p>기존 ADC 감시와 보드 자동 반응은 그대로예요. 값이 낮거나 측정에 실패해도 안전하다는 뜻은 아니에요.</p><Link className="text-link" to="/settings?section=gas">기존 감시 기준 보기</Link></div></section></div>
  </StatusSheet>;
}

export function DoorStatus() {
  const { state } = useHome(), s = state.snapshot;
  if (!s) return <LoadingState/>;
  const fresh = s.online && !state.error;
  const baseline = s.settings.doorCalibrated ? s.settings.closedDistance : null;
  const comparison = compareDoorDistance(s.sensor.distance, baseline, fresh);
  const label = comparison.state === "within" ? "기준 범위" : comparison.state === "outside" ? "거리 변화" : "확인 불가";
  return <StatusSheet title="문 작동 확인" description="실제로 확인한 닫힘 거리에서 얼마나 달라졌는지 살펴봐요.">
    <section className={`panel status-detail-primary door-comparison door-comparison--${comparison.state}`}><IconBadge icon={DoorClosed} tone="blue"/><p className="status-kicker">닫힘 기준과 비교한 현재 거리</p><h2 data-door-comparison>{label}</h2><p className="status-explanation">{!fresh ? "새 측정값이 없어 현재 문 상태를 확인할 수 없어요." : s.sensor.distance === null ? "초음파 응답이 없어요. 문 열림으로 처리하지 않아요." : baseline === null ? "문을 실제로 닫고 설정에서 기준 거리를 확인해 주세요." : comparison.state === "within" ? "닫힘 기준에서 ±10cm 이내에 있어요." : "닫힘 기준에서 10cm 넘게 벗어났어요. 실제 문을 확인해 주세요."}</p><div className="distance-ruler" aria-hidden="true"><span>−10cm</span><span className="distance-ruler-center">닫힘 기준</span><span>+10cm</span></div><p className="status-caption">범위 표시는 화면 비교용이에요. 실제 문 열림·출입의 확정이나 기존 자동 감지의 기준 변경은 아니에요.</p></section>
    <div className="status-detail-secondary"><section className="panel measurement-panel"><h2>거리 비교</h2><dl className="distance-readings"><div><dt>현재 거리</dt><dd>{fresh && s.sensor.distance !== null ? s.sensor.distance.toFixed(1) : "—"}<small>cm</small></dd></div><div><dt>확인한 닫힘 기준</dt><dd>{baseline === null ? "—" : baseline.toFixed(1)}<small>cm</small></dd></div><div><dt>기준과의 차이</dt><dd data-door-delta>{comparison.delta === null ? "—" : `${comparison.delta > 0 ? "+" : ""}${comparison.delta.toFixed(1)}`}<small>cm</small></dd></div></dl><p className="field-help">{baseline === null ? "기본 입력값은 실제 확인한 기준으로 사용하지 않아요." : `기존 자동 감지의 변화량 ${s.settings.doorTolerance}cm·지속 ${s.settings.doorConfirmSeconds}초 설정은 그대로 유지해요.`}</p><Link to="/settings?section=door" className="secondary-button">닫힘 기준 확인·보정</Link></section><section className="status-help"><CircleHelp size={20}/><div><h2>무응답은 문 작동이 아니에요</h2><p>현재 V4는 Trig D9 · Echo D8이에요. 이전 중계용 코드와 배선을 섞지 말고, 실제 기기 연결 방식을 먼저 확인해 주세요.</p><Link to="/devices" className="text-link">연결·배선 안내 보기</Link></div></section></div>
  </StatusSheet>;
}
