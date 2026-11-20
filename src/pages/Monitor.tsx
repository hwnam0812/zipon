import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import { LoadingState, PageHeading, Pill, SafetyNote } from "../home/ui";
import { kstClock } from "../lib/home-model";

export default function Monitor() {
  const { state } = useHome(), s = state.snapshot;
  if (!s) return <LoadingState/>;
  const fresh = s.online && !state.error;
  return <>
    <PageHeading title="실시간 측정값" aside={<Pill>{fresh ? "측정값 수신 중" : "현재 확인 불가"}</Pill>}/>
    <div className="live-measurements">
      <section className="panel measurement-panel"><h2>가스 원시 출력</h2><p className="measurement-number">{fresh && s.sensor.gasSensor === "MQ-135" && s.sensor.gasAdc != null ? s.sensor.gasAdc : "—"}<span>ADC</span></p><p className="field-help">근사 전압 {fresh && s.sensor.gasVoltageV != null ? `${s.sensor.gasVoltageV.toFixed(2)} V` : "확인 불가"} · 농도 환산 없음</p><Link className="text-link" to="/gas-status">가스 센서 상태 보기</Link></section>
      <section className="panel measurement-panel"><h2>초음파 거리</h2><p className="measurement-number">{fresh && s.sensor.distance !== null ? s.sensor.distance.toFixed(1) : "—"}<span>cm</span></p><p className="field-help">{!fresh ? "새 측정을 기다려요." : s.sensor.distance === null ? "초음파 응답 없음 · 문 열림이 아니에요." : "실제 사람의 출입을 확정하지 않아요."}</p><Link className="text-link" to="/door-status">문 작동 확인 보기</Link></section>
    </div>
    <p className="live-measurement-time">마지막 수신 {s.sensor.lastSeen ? `${kstClock(s.sensor.lastSeen, true)}${fresh ? "" : " · 지난 보고"}` : "아직 없어요"} · 3초마다 화면 조회</p>
    <section className="panel measurement-panel"><h2>USB 직접 연결·그래프</h2><p className="panel-description">기존 연결 방식과 별도로, UNO가 꽂힌 컴퓨터에서 USB 직접 연결과 최근 그래프를 사용할 수 있어요. 두 연결 방식의 코드를 섞지 마세요.</p><a href="/streamlit/?page=monitor" className="secondary-button"><ExternalLink size={16}/>USB 직접 연결 화면 열기</a><p className="field-help">V4 · 9600 baud · Trig D9 · Echo D8 · LED D7. 이전 중계와 시리얼 모니터는 먼저 닫아 주세요.</p></section>
    <SafetyNote/>
  </>;
}
