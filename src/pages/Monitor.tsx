import { Cable, ExternalLink, Info, Usb } from "lucide-react";
import { PageHeading, SafetyNote } from "../home/ui";

export default function Monitor() {
  return <>
    <PageHeading title="실시간 모니터링" description="USB로 연결한 UNO의 센서값과 출력 상태를 확인해요."/>
    <section className="sensor-card" style={{ padding: 28, maxWidth: 780 }}>
      <Usb size={30} color="#527b4c"/>
      <h2 style={{ fontSize: 21, margin: "18px 0 10px" }}>Streamlit 모니터링 화면</h2>
      <p style={{ lineHeight: 1.8, color: "#53675c", wordBreak: "keep-all" }}>기존 가족 공간은 그대로 두고, 새 USB 연결·그래프·감시 설정은 Streamlit 화면에서 사용해요. 같은 가족 비밀번호로 들어갈 수 있어요.</p>
      <a href="/streamlit/?page=monitor" className="button button--primary" style={{ display: "inline-flex", marginTop: 18, alignItems: "center", gap: 8 }}><ExternalLink size={17}/>모니터링 화면 열기</a>
      <p style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 24, lineHeight: 1.8 }}><Cable size={18} style={{ flexShrink: 0, marginTop: 3 }}/>새 V4 스케치 · 9600 baud · MQ-135 A5 · Trig D9 · Echo D11</p>
      <p style={{ display: "flex", gap: 8, fontSize: 13, lineHeight: 1.8 }}><Info size={18} style={{ flexShrink: 0, marginTop: 3 }}/>USB는 UNO가 꽂힌 컴퓨터의 지원 브라우저에서 연결해요. 이전 중계와 시리얼 모니터는 먼저 닫아 주세요.</p>
    </section>
    <SafetyNote/>
  </>;
}
