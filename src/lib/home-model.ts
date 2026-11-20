export type FireStatus = "normal" | "watch" | "risk" | "unknown";
export type DoorStatus = "open" | "closed" | "unknown";
export type EventKind = "door_open" | "door_closed" | "fire_risk" | "fire_clear" | "siren_requested" | "siren_started" | "siren_stopped" | "gas_alert" | "gas_below" | "output_requested" | "output_applied" | "output_rejected" | "sensor_settings";
export const automationProtocol = "ZIPON_AUTO_V3";
export type OutputTarget = "led" | "buzzer" | "alarm";
export type OutputAction = "on" | "off" | "test" | "mute" | "resume";
export type OutputCommand = {
  id: string; target: OutputTarget; action: OutputAction; seconds: number;
  status: "pending" | "claimed" | "applied" | "rejected" | "expired" | "cancelled";
  created_at: string; expires_at: string; claimed_at: string | null; applied_at: string | null; session: string;
};
export type GasStatus = "disabled" | "below" | "watch" | "alert" | "fault";
export type OutputSource = "off" | "manual" | "door" | "gas" | "paused";
export type BoardReport = {
  session: string; sequence: number; uptimeMs: number; configRevision: string;
  doorStatus: DoorStatus; gasStatus: GasStatus; gasAlarm: boolean;
  ledOn: boolean; buzzerOn: boolean; ledSource: OutputSource; buzzerSource: OutputSource;
  muteSeconds: number; ledOffSeconds: number; buzzerOffSeconds: number;
};
export type BoardEvent = { sequence: number; kind: "door_open" | "door_closed" | "gas_alert" | "gas_below"; uptimeMs: number; gasAdc: number | null; distanceCm: number | null };
export type BoardConfig = { revision: string; closedMm: number; toleranceMm: number; doorHoldMs: number; doorCalibrated: boolean; doorSignals: boolean; gasEnabled: boolean; baselineAdc: number; riseAdc: number; gasHoldMs: number };
export type HomeEvent = { id: string; kind: EventKind; title: string; detail: string; emergency: number; created_at: string };
export type HomeAlert = { id: string; title: string; message: string; kind: EventKind; created_at: string; read_at: string | null };
export type SirenCommand = {
  id: string; action: "start" | "stop"; seconds: number;
  status: "pending" | "acknowledged" | "completed" | "expired" | "cancelled";
  created_at: string; expires_at: string; started_at: string | null; completed_at: string | null;
};
export type QuietWindow = { id: string; name: string; enabled: boolean; start: string; end: string; days: number[] };
export const maxQuietWindows = 20;
export type HomeSettings = {
  homeName: string; quietEnabled: boolean; quietWindows: QuietWindow[];
  fireAlerts: boolean; doorAlerts: boolean; dustThreshold: number; sustainedSeconds: number;
  closedDistance: number; doorTolerance: number; sirenSeconds: number;
  doorCalibrated: boolean; doorConfirmSeconds: number; doorSignals: boolean;
  gasEnabled: boolean; gasWarmupConfirmed: boolean; gasArmSession: string | null;
  gasBaselineAdc: number | null; gasRiseAdc: number; gasSustainedSeconds: number; gasAlerts: boolean;
};
export type SensorState = {
  gasSensor?: "MQ-135" | null; gasVoltageV?: number | null; gasAdc?: number | null;
  dustSensor?: "GP2Y1014AU0F" | null; dustVoltageV?: number | null;
  dust: number | null; distance: number | null; fireStatus: FireStatus; doorStatus: DoorStatus;
  lastSeen: string | null; aboveSince: number | null; belowSince: number | null;
  doorCandidate: DoorStatus; candidateSince: number | null;
  board: BoardReport | null;
};
export type HomeSnapshot = {
  settings: HomeSettings; sensor: SensorState; online: boolean;
  events: HomeEvent[]; alerts: HomeAlert[]; todayOpenCount: number;
  command: SirenCommand | null; device: { paired: boolean; name: string };
  outputCommands: OutputCommand[]; boardConfig: BoardConfig;
  serverTime: string;
};

// These are unvalidated starting examples, NOT fire-safety thresholds.
export const defaultSettings: HomeSettings = {
  homeName: "우리 집", quietEnabled: true,
  quietWindows: [{ id: "night", name: "밤 시간", enabled: true, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] }],
  fireAlerts: true, doorAlerts: true,
  dustThreshold: 150, sustainedSeconds: 10, closedDistance: 12, doorTolerance: 8, sirenSeconds: 10,
  doorCalibrated: false, doorConfirmSeconds: 1, doorSignals: true,
  gasEnabled: false, gasWarmupConfirmed: false, gasArmSession: null,
  gasBaselineAdc: null, gasRiseAdc: 100, gasSustainedSeconds: 10, gasAlerts: true,
};
export const emptySensor: SensorState = {
  gasSensor: null, gasVoltageV: null, gasAdc: null,
  dustSensor: null, dustVoltageV: null,
  dust: null, distance: null, fireStatus: "unknown", doorStatus: "unknown", lastSeen: null,
  aboveSince: null, belowSince: null, doorCandidate: "unknown", candidateSince: null,
  board: null,
};

/** Display-only comparison. It never changes board alarms, settings or saved events. */
export function compareDoorDistance(distance: number | null, baseline: number | null, fresh: boolean): { state: "unavailable" | "within" | "outside"; delta: number | null } {
  if (!fresh || distance === null || baseline === null || !Number.isFinite(distance) || !Number.isFinite(baseline) || distance < 2 || distance > 400 || baseline < 2 || baseline > 390) return { state: "unavailable", delta: null };
  const delta = distance - baseline;
  const boundarySlack = Number.EPSILON * Math.max(distance, baseline) * 4;
  return { state: Math.abs(delta) <= 10 + boundarySlack ? "within" : "outside", delta };
}

export function kstDay(when: string | number | Date = Date.now()): string {
  return new Date(new Date(when).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function kstClock(when: string | number | Date, seconds = false): string {
  return new Date(new Date(when).getTime() + 9 * 3600_000).toISOString().slice(11, seconds ? 19 : 16);
}
export function activeQuietWindows(settings: HomeSettings, when: number = Date.now()): QuietWindow[] {
  if (!settings.quietEnabled || !settings.doorAlerts || !Number.isFinite(when)) return [];
  const d = new Date(when + 9 * 3600_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const toMinute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return settings.quietWindows.filter(window => {
    if (!window.enabled) return false;
    const start = toMinute(window.start), end = toMinute(window.end);
    let day = d.getUTCDay();
    if (start < end) return minute >= start && minute < end && window.days.includes(day);
    if (minute < end) day = (day + 6) % 7;
    return start !== end && (minute >= start || minute < end) && window.days.includes(day);
  });
}
export function isQuietTime(settings: HomeSettings, when: number = Date.now()): boolean {
  return activeQuietWindows(settings, when).length > 0;
}
export function quietDaysLabel(days: number[]): string {
  if (days.length === 7) return "매일";
  if (days.length === 5 && [1, 2, 3, 4, 5].every(day => days.includes(day))) return "월~금";
  return [1, 2, 3, 4, 5, 6, 0].filter(day => days.includes(day)).map(day => ["일", "월", "화", "수", "목", "금", "토"][day]).join("·");
}

/** Read older single-window settings without rewriting stored family records. */
export function normalizeHomeSettings(input?: unknown): HomeSettings {
  const saved = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const quietWindows = Array.isArray(saved.quietWindows) ? saved.quietWindows :
    typeof saved.quietStart === "string" && typeof saved.quietEnd === "string" && Array.isArray(saved.quietDays) ?
      [{ id: "existing", name: "기존 안심 시간", enabled: true, start: saved.quietStart, end: saved.quietEnd, days: saved.quietDays }] : defaultSettings.quietWindows;
  const result = validateHomeSettings({ ...defaultSettings, ...saved, quietWindows });
  if (result.value) return result.value;
  return { ...defaultSettings, quietWindows: defaultSettings.quietWindows.map(window => ({ ...window, days: [...window.days] })) };
}

export function validateHomeSettings(input: unknown): { value?: HomeSettings; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "설정 내용을 다시 확인해 주세요." };
  const v = input as Record<string, unknown>;
  if (typeof v.homeName !== "string" || !v.homeName.trim() || v.homeName.trim().length > 20) return { error: "집 이름은 1~20자로 적어 주세요." };
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(v.quietWindows) || v.quietWindows.length > maxQuietWindows) return { error: `안심 시간은 최대 ${maxQuietWindows}개까지 저장할 수 있어요.` };
  const ids = new Set<string>(), quietWindows: QuietWindow[] = [];
  for (const [index, item] of v.quietWindows.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "안심 시간 내용을 다시 확인해 주세요." };
    const w = item as Record<string, unknown>, prefix = `안심 시간 ${index + 1}: `;
    if (typeof w.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(w.id) || ids.has(w.id)) return { error: "안심 시간이 중복되었어요. 다시 추가해 주세요." };
    if (typeof w.name !== "string" || !w.name.trim() || w.name.trim().length > 24) return { error: `${prefix}이름은 1~24자로 적어 주세요.` };
    if (typeof w.enabled !== "boolean") return { error: `${prefix}켜짐 상태를 다시 확인해 주세요.` };
    if (typeof w.start !== "string" || !time.test(w.start) || typeof w.end !== "string" || !time.test(w.end)) return { error: `${prefix}시작·종료 시간을 선택해 주세요.` };
    if (w.start === w.end) return { error: `${prefix}시작 시간과 종료 시간을 다르게 선택해 주세요.` };
    if (!Array.isArray(w.days) || !w.days.length || w.days.some(day => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) return { error: `${prefix}반복 요일을 하나 이상 선택해 주세요.` };
    ids.add(w.id);
    quietWindows.push({ id: w.id, name: w.name.trim(), enabled: w.enabled, start: w.start, end: w.end, days: [...new Set(w.days as number[])].sort((a, b) => a - b) });
  }
  for (const key of ["quietEnabled", "fireAlerts", "doorAlerts", "doorCalibrated", "doorSignals", "gasEnabled", "gasWarmupConfirmed", "gasAlerts"] as const) {
    if (typeof v[key] !== "boolean") return { error: "알림 설정을 다시 확인해 주세요." };
  }
  const limits = { dustThreshold: [1, 5000], sustainedSeconds: [5, 60], closedDistance: [2, 390], doorTolerance: [2, 100], sirenSeconds: [5, 15], doorConfirmSeconds: [1, 5], gasRiseAdc: [1, 1022], gasSustainedSeconds: [5, 60] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || Number(v[key]) < min || Number(v[key]) > max) return { error: "센서 기준값과 사이렌 시간을 허용 범위 안에서 설정해 주세요." };
  }
  if (!Number.isInteger(v.sustainedSeconds) || !Number.isInteger(v.sirenSeconds)) return { error: "지속 시간은 초 단위의 정수로 설정해 주세요." };
  if (![v.doorConfirmSeconds, v.gasRiseAdc, v.gasSustainedSeconds].every(Number.isInteger)) return { error: "가스 ADC와 감지 지속 시간은 정수로 입력해 주세요." };
  if (v.gasBaselineAdc !== null && (typeof v.gasBaselineAdc !== "number" || !Number.isInteger(v.gasBaselineAdc) || v.gasBaselineAdc < 1 || v.gasBaselineAdc > 1022)) return { error: "가스 기준 ADC는 1~1022 사이 정수로 입력해 주세요. 끝값은 기준으로 쓰지 않아요." };
  if (v.gasBaselineAdc !== null && Number(v.gasBaselineAdc) + Number(v.gasRiseAdc) > 1023) return { error: "가스 기준 ADC와 상승 폭의 합은 1023 이하여야 해요." };
  if (v.gasArmSession !== null && (typeof v.gasArmSession !== "string" || !/^[a-f0-9]{32}$/.test(v.gasArmSession))) return { error: "가스 감시를 시작할 연결을 다시 확인해 주세요." };
  if (v.gasEnabled && (!v.gasWarmupConfirmed || v.gasBaselineAdc === null || v.gasArmSession === null)) return { error: "예열·기준값을 직접 확인하고 이번 연결에서 가스 출력 감시를 켜 주세요." };
  return { value: {
    homeName: v.homeName.trim(), quietEnabled: v.quietEnabled as boolean, quietWindows,
    fireAlerts: v.fireAlerts as boolean, doorAlerts: v.doorAlerts as boolean,
    dustThreshold: Number(v.dustThreshold), sustainedSeconds: Number(v.sustainedSeconds),
    closedDistance: Number(v.closedDistance), doorTolerance: Number(v.doorTolerance), sirenSeconds: Number(v.sirenSeconds),
    doorCalibrated: v.doorCalibrated as boolean, doorConfirmSeconds: Number(v.doorConfirmSeconds), doorSignals: v.doorSignals as boolean,
    gasEnabled: v.gasEnabled as boolean, gasWarmupConfirmed: v.gasWarmupConfirmed as boolean, gasArmSession: v.gasArmSession as string | null,
    gasBaselineAdc: v.gasBaselineAdc as number | null, gasRiseAdc: Number(v.gasRiseAdc), gasSustainedSeconds: Number(v.gasSustainedSeconds), gasAlerts: v.gasAlerts as boolean,
  } };
}

export const eventTitles: Record<EventKind, string> = {
  door_open: "현관문이 열렸어요", door_closed: "현관문이 닫혔어요",
  fire_risk: "화재 의심 징후가 감지됐어요", fire_clear: "먼지 수치가 기준 아래로 내려왔어요",
  siren_requested: "사이렌을 요청했어요", siren_started: "사이렌 실행 응답을 받았어요", siren_stopped: "사이렌 중지 응답을 받았어요",
  gas_alert: "가스 출력 이상·화재 여부 확인 필요", gas_below: "가스 출력이 복귀 기준 아래로 이어졌어요",
  output_requested: "LED·부저 제어를 요청했어요", output_applied: "보드의 제어 실행 응답을 받았어요", output_rejected: "보드가 제어 요청을 거절했어요", sensor_settings: "센서·자동 반응 설정을 저장했어요",
};

/** Classify consecutive readings on the server; the board never decides the displayed safety status. */
export function analyzeSample(previous: SensorState, sample: { dust: number | null; distance: number | null; dustSensor?: "GP2Y1014AU0F" | null; dustVoltageV?: number | null; gasSensor?: "MQ-135" | null; gasVoltageV?: number | null; gasAdc?: number | null }, settings: HomeSettings, now: number) {
  const rawDust = sample.dustSensor === "GP2Y1014AU0F";
  const gas = sample.gasSensor === "MQ-135";
  const dust = rawDust || gas ? null : sample.dust;
  const next: SensorState = { ...previous, ...sample, board: null, dust, dustSensor: !gas && rawDust ? "GP2Y1014AU0F" : null, dustVoltageV: !gas && rawDust ? sample.dustVoltageV ?? null : null, gasSensor: gas ? "MQ-135" : null, gasVoltageV: gas ? sample.gasVoltageV ?? null : null, gasAdc: gas ? sample.gasAdc ?? null : null, lastSeen: new Date(now).toISOString() };
  const changes: EventKind[] = [];
  const continuous = previous.lastSeen !== null && now - Date.parse(previous.lastSeen) <= 6500;
  if (!continuous) { next.aboveSince = null; next.belowSince = null; next.candidateSince = null; }
  if (dust === null) {
    next.aboveSince = null; next.belowSince = null;
    next.fireStatus = previous.fireStatus === "risk" ? "risk" : "unknown";
  } else if (dust >= settings.dustThreshold) {
    next.aboveSince ??= now;
    next.belowSince = null;
    next.fireStatus = previous.fireStatus === "risk" || now - next.aboveSince >= settings.sustainedSeconds * 1000 ? "risk" : "watch";
  } else if (previous.fireStatus === "risk") {
    if (dust < settings.dustThreshold * 0.7) {
      next.belowSince ??= now;
      if (now - next.belowSince >= settings.sustainedSeconds * 1000) next.fireStatus = "normal";
    } else next.belowSince = null;
    next.aboveSince = null;
  } else {
    next.fireStatus = "normal"; next.aboveSince = null; next.belowSince = null;
  }
  if (next.fireStatus === "risk" && previous.fireStatus !== "risk") changes.push("fire_risk");
  if (next.fireStatus === "normal" && previous.fireStatus === "risk") changes.push("fire_clear");
  if (sample.distance === null) {
    next.doorStatus = "unknown"; next.doorCandidate = "unknown"; next.candidateSince = null;
  } else {
    const candidate = Math.abs(sample.distance - settings.closedDistance) > settings.doorTolerance ? "open" : "closed";
    if (candidate !== previous.doorCandidate || next.candidateSince === null) {
      next.doorCandidate = candidate; next.candidateSince = now;
    } else if (now - next.candidateSince >= 1000 && candidate !== previous.doorStatus) {
      next.doorStatus = candidate;
      // The first closed reading is a baseline, not a door operation.
      if (candidate === "open" || previous.doorStatus === "open") changes.push(candidate === "open" ? "door_open" : "door_closed");
    }
  }
  return { next, changes };
}

export function hardwareConfig(settings: HomeSettings, session: string | null): Omit<BoardConfig, "revision"> {
  return { closedMm: Math.round(settings.closedDistance * 10), toleranceMm: Math.round(settings.doorTolerance * 10),
    doorHoldMs: settings.doorConfirmSeconds * 1000, doorCalibrated: settings.doorCalibrated, doorSignals: settings.doorSignals,
    gasEnabled: Boolean(settings.gasEnabled && settings.gasWarmupConfirmed && session && settings.gasArmSession === session),
    baselineAdc: settings.gasBaselineAdc ?? 0, riseAdc: settings.gasRiseAdc, gasHoldMs: settings.gasSustainedSeconds * 1000 };
}

export const gasStatusLabels: Record<GasStatus, string> = { disabled: "출력 감시 꺼짐", below: "설정 기준 미만", watch: "상승 지속 확인 중", alert: "가스 출력 이상", fault: "측정·배선 확인" };
export const outputSourceLabels: Record<OutputSource, string> = { off: "반응 없음", manual: "수동 요청", door: "문 동작 반응", gas: "가스 출력 경고", paused: "일시 중지" };
export const outputCommandLabels: Record<OutputCommand["status"], string> = { pending: "요청 대기", claimed: "USB 전달 준비·보드 응답 전", applied: "보드 실행 응답 수신", rejected: "보드 거절", expired: "응답 기한 만료·실행 미확인", cancelled: "요청 취소·전달된 동작의 중지는 미확인" };
