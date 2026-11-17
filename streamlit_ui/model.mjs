// Shared, dependency-free browser model. No sensor samples are generated here.
export const USB_PROTOCOL = "ZIPON_USB_V4";
export const MAX_POINTS = 600;
export const MAX_EVENTS = 2000;
export const FRESH_MS = 3500;
export const DEFAULT_SETTINGS = {
  homeName: "우리 집", quietEnabled: true,
  quietWindows: [{ id: "night", name: "밤 시간", enabled: true, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] }],
  gas: { warmupConfirmed: false, baseline: null, threshold: null, recovery: null, holdSeconds: 10, recoverySeconds: 10 },
  intrusion: { enabled: false, baselineCm: 12, deltaCm: 8, holdSeconds: 2, recoverySeconds: 2, cooldownSeconds: 30, allowedWindows: [] },
};
export const EVENT_TITLES = {
  usb_connected: "USB 연결", usb_disconnected: "USB 연결 해제", device_boot: "보드 재시작",
  gas_alert: "화재·가스 위험 의심", gas_clear: "가스 출력 경보 해제", intrusion_alert: "출입 의심 감지",
  intrusion_clear: "출입 의심 해제", intrusion_stopped: "출입 감시 요청 종료", door_open: "기준 거리 벗어남", door_closed: "기준 거리 복귀",
  led_on: "LED 작동", led_off: "LED 정지", buzzer_on: "부저 작동", buzzer_off: "부저 정지",
  sensor_error: "센서 측정 오류", sensor_recovered: "센서 측정 복구", command_requested: "출력 제어 요청",
  command_applied: "보드 실행 응답", command_rejected: "출력 요청 거절", command_expired: "출력 응답 없음",
  settings_saved: "감시 설정 변경", quiet_door: "안심 시간 거리 변화", monitoring_started: "감시 시작 요청",
};
export const clone = value => JSON.parse(JSON.stringify(value));
export const finite = (n, min, max) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
export const integer = (n, min, max) => finite(n, min, max) && Number.isInteger(n);
export const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export function kstParts(time = Date.now()) {
  const d = new Date(time + 9 * 3600000);
  return { day: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), date: d.toISOString().slice(0, 10), clock: d.toISOString().slice(11, 19) };
}
export function inWindows(windows, time = Date.now()) {
  const { day, minute } = kstParts(time);
  return windows.some(w => {
    if (!w.enabled) return false;
    const a = Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3)), b = Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3));
    if (a < b) return w.days.includes(day) && minute >= a && minute < b;
    const startDay = minute < b ? (day + 6) % 7 : day;
    return a !== b && w.days.includes(startDay) && (minute >= a || minute < b);
  });
}
export function validateSettings(s) {
  if (!object(s) || typeof s.homeName !== "string" || !s.homeName.trim() || s.homeName.trim().length > 20) throw new Error("집 이름은 1~20자로 적어 주세요.");
  const checkWindows = windows => {
    if (!Array.isArray(windows) || windows.length > 20) throw new Error("시간표는 각각 최대 20개까지 추가할 수 있어요.");
    const ids = new Set();
    for (const w of windows) {
      if (!object(w) || typeof w.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(w.id) || ids.has(w.id) || typeof w.name !== "string" || !w.name.trim() || w.name.length > 24 || typeof w.enabled !== "boolean" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end) || w.start === w.end || !Array.isArray(w.days) || !w.days.length || w.days.some(d => !integer(d, 0, 6))) throw new Error("시간 이름·서로 다른 시작과 종료 시간·반복 요일을 확인해 주세요.");
      ids.add(w.id);
    }
  };
  if (typeof s.quietEnabled !== "boolean") throw new Error("안심 시간 사용 여부를 확인해 주세요.");
  checkWindows(s.quietWindows);
  const g = s.gas, i = s.intrusion;
  if (!object(g) || typeof g.warmupConfirmed !== "boolean" || !integer(g.holdSeconds, 5, 60) || !integer(g.recoverySeconds, 5, 60)) throw new Error("가스 지속 시간은 5~60초 정수로 입력해 주세요.");
  if (![g.baseline, g.threshold, g.recovery].every(n => n === null || integer(n, 1, 1022))) throw new Error("가스 ADC는 1~1022 사이 정수로 입력해 주세요.");
  if (g.baseline !== null && g.threshold !== null && g.baseline >= g.threshold || g.recovery !== null && g.threshold !== null && g.recovery >= g.threshold || g.recovery !== null && g.baseline !== null && g.recovery < g.baseline) throw new Error("가스 기준값 ≤ 복귀 기준 < 경보 기준이 되도록 입력해 주세요.");
  if (!object(i) || typeof i.enabled !== "boolean" || !finite(i.baselineCm, 2, 390) || !finite(i.deltaCm, 2, 100) || !integer(i.holdSeconds, 1, 30) || !integer(i.recoverySeconds, 1, 30) || !integer(i.cooldownSeconds, 5, 600)) throw new Error("거리 기준·변화량·지속 시간·반복 방지 시간을 확인해 주세요.");
  checkWindows(i.allowedWindows);
  return clone({ ...s, homeName: s.homeName.trim() });
}
export function gasReady(settings) {
  const g = settings.gas;
  return g.warmupConfirmed && [g.baseline, g.recovery, g.threshold].every(n => integer(n, 1, 1022)) && g.baseline <= g.recovery && g.recovery < g.threshold;
}
export function parseFrame(line) {
  if (typeof line !== "string" || line.length > 768 || /[^\x20-\x7e]/.test(line)) throw new Error("올바르지 않은 USB 메시지예요.");
  let p; try { p = JSON.parse(line); } catch { throw new Error("USB 메시지가 완성되지 않았어요."); }
  if (!object(p) || p.protocol !== USB_PROTOCOL) throw new Error("새 V4 스케치와 9600 설정을 확인해 주세요.");
  if (p.type === "boot") return p;
  if (!/^[a-f0-9]{16}$/.test(p.session ?? "")) throw new Error("USB 연결 확인값이 올바르지 않아요.");
  if (p.type === "ready") return p;
  if (p.type === "ack") {
    if (!/^[a-f0-9]{8}$/.test(p.id ?? "") || typeof p.applied !== "boolean" || typeof p.reason !== "string" || p.reason.length > 32) throw new Error("출력 실행 응답이 올바르지 않아요.");
    return p;
  }
  const sources = ["off", "manual", "gas", "intrusion"];
  if (p.type !== "telemetry" || !integer(p.seq, 1, 4294967295) || !integer(p.uptimeMs, 0, 4294967295) || !(p.gasRaw === null || integer(p.gasRaw, 0, 1023)) || !(p.distanceCm === null || finite(p.distanceCm, 2, 400)) || !["disabled", "below", "watch", "alert", "fault"].includes(p.gasState) || ![p.gasAlarm, p.intrusionAlarm, p.led, p.buzzer, p.manualLed, p.manualBuzzer].every(v => typeof v === "boolean") || !sources.includes(p.ledSource) || !sources.includes(p.buzzerSource) || !integer(p.config, 0, 2147483647)) throw new Error("센서값이나 출력 보고가 올바르지 않아요.");
  const ledSource = p.gasAlarm ? "gas" : p.manualLed ? "manual" : "off";
  const buzzerSource = p.gasAlarm ? "gas" : p.intrusionAlarm ? "intrusion" : p.manualBuzzer ? "manual" : "off";
  if (p.gasState === "alert" && !p.gasAlarm || p.gasState === "disabled" && p.gasAlarm || p.ledSource !== ledSource || p.buzzerSource !== buzzerSource || p.led !== (ledSource !== "off") || p.buzzer !== (buzzerSource !== "off")) throw new Error("보드의 경보와 출력 보고가 일치하지 않아요.");
  return p;
}
export function boundedPush(array, value, maximum) { array.push(value); if (array.length > maximum) array.splice(0, array.length - maximum); }
export function eventRecord(kind, sample, detail = "", time = Date.now()) {
  return { id: crypto.randomUUID(), kind, created_at: new Date(time).toISOString(), gas_raw: sample?.gasRaw ?? null, distance_cm: sample?.distanceCm ?? null, led: sample?.led ?? null, buzzer: sample?.buzzer ?? null, detail: String(detail).slice(0, 400), legacy: false };
}
