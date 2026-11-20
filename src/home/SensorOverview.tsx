import { Link } from "react-router";
import { ArrowUpRight, DoorClosed, Wind } from "lucide-react";
import { useHome } from "./HomeProvider";
import { IconBadge, Pill } from "./ui";
import { compareDoorDistance } from "../lib/home-model";

export default function SensorOverview() {
  const { state } = useHome(), s = state.snapshot!;
  const fresh = s.online && !state.error;
  const comparison = compareDoorDistance(s.sensor.distance, s.settings.doorCalibrated ? s.settings.closedDistance : null, fresh);
  const gasMeasured = fresh && s.sensor.gasSensor === "MQ-135" && s.sensor.gasAdc != null;
  const endpoint = gasMeasured && (s.sensor.gasAdc === 0 || s.sensor.gasAdc === 1023);
  const legacyRisk = s.sensor.fireStatus === "risk";
  return <div className="sensor-grid sensor-overview">
    <Link to="/gas-status" className="panel status-card" aria-label="가스 센서 상태 상세 보기">
      <div className="status-card-heading"><IconBadge icon={Wind} tone="orange"/><h2>가스 센서 상태</h2><ArrowUpRight size={18}/></div>
      <div className="status-card-result"><span>화재 위험</span><strong>판단 불가</strong><Pill tone={s.sensor.board?.gasAlarm || legacyRisk || endpoint ? "warning" : "neutral"}>{s.sensor.board?.gasAlarm ? "출력 경고 기록 있음" : legacyRisk ? "이전 경보 유지" : !fresh ? "새 측정 대기" : endpoint ? "범위 끝값" : !gasMeasured ? "측정 확인 필요" : "농도 미측정"}</Pill></div>
      <div className="status-card-reading"><span>현재 원시값</span><b className="sensor-number">{gasMeasured ? s.sensor.gasAdc : "—"}<small>ADC</small></b></div>
      <p>{endpoint ? "범위 끝값이에요. 배선·전원·출력 범위를 확인해 주세요." : fresh && !gasMeasured ? "측정값을 확인하지 못했어요. 배선·전원과 새 코드를 확인해 주세요." : "5,000ppm 기준 미적용 · 실제 농도로 환산하지 않아요."}</p><span className="status-card-link">센서와 기준 살펴보기 <ArrowUpRight size={15}/></span>
    </Link>
    <Link to="/door-status" className="panel status-card" aria-label="문 작동 확인 상세 보기">
      <div className="status-card-heading"><IconBadge icon={DoorClosed} tone="blue"/><h2>문 작동 확인</h2><ArrowUpRight size={18}/></div>
      <div className="status-card-result"><span>닫힘 기준 ±10cm 비교</span><strong>{comparison.state === "unavailable" ? "확인 불가" : comparison.state === "within" ? "기준 범위" : "거리 변화"}</strong><Pill tone={comparison.state === "outside" ? "warning" : "neutral"}>{!fresh ? "새 측정 대기" : s.sensor.distance === null ? "초음파 응답 없음" : !s.settings.doorCalibrated ? "기준 확인 필요" : "화면 비교용"}</Pill></div>
      <div className="status-card-reading"><span>현재 거리</span><b className="sensor-number">{fresh && s.sensor.distance !== null ? s.sensor.distance.toFixed(1) : "—"}<small>cm</small></b></div>
      <p>거리 변화 표시예요. 문 열림·실제 출입을 확정하지 않아요.</p><span className="status-card-link">거리와 기준 살펴보기 <ArrowUpRight size={15}/></span>
    </Link>
  </div>;
}
