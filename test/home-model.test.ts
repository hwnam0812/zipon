import assert from "node:assert/strict";
import { test } from "node:test";
import { activeQuietWindows, analyzeSample, compareDoorDistance, defaultSettings, emptySensor, isQuietTime, kstDay, maxQuietWindows, normalizeHomeSettings, quietDaysLabel, validateHomeSettings, type QuietWindow } from "../src/lib/home-model.ts";

const settings = normalizeHomeSettings();
const at = (value: string) => Date.parse(`${value}+09:00`);
const window = (change: Partial<QuietWindow> = {}): QuietWindow => ({ ...defaultSettings.quietWindows[0], days: [...defaultSettings.quietWindows[0].days], ...change });

test("문 화면 비교는 ±10cm 경계를 포함하고 기준·설정·원래 감지를 변경하지 않는다", () => {
  const before = structuredClone(settings);
  for (const [distance, baseline, state] of [[12, 12, "within"], [2, 12, "within"], [22, 12, "within"], [22.1, 12.1, "within"], [22.2, 12.1, "outside"], [2.1, 12.2, "outside"]] as const) {
    assert.equal(compareDoorDistance(distance, baseline, true).state, state);
  }
  assert.deepEqual(settings, before);
});

test("문 화면은 미보정·무응답·오래된 값·잘못된 거리를 정상으로 표시하지 않는다", () => {
  for (const [distance, baseline, fresh] of [[12, null, true], [null, 12, true], [12, 12, false], [0, 12, true], [401, 12, true], [12, Number.NaN, true], [Number.POSITIVE_INFINITY, 12, true]] as const) {
    assert.deepEqual(compareDoorDistance(distance, baseline, fresh), { state: "unavailable", delta: null });
  }
});

test("MQ-135의 지속적인 최대 출력도 농도·화재 경보로 환산하지 않는다", () => {
  let state = { ...emptySensor };
  for (let now = 100_000; now <= 150_000; now += 2000) {
    const result = analyzeSample(state, { dust: 5000, distance: 12, gasSensor: "MQ-135", gasVoltageV: 5, gasAdc: 1023 }, settings, now);
    state = result.next;
    assert.equal(state.gasSensor, "MQ-135");
    assert.equal(state.gasAdc, 1023); assert.equal(state.gasVoltageV, 5);
    assert.equal(state.dust, null); assert.equal(state.dustSensor, null);
    assert.equal(state.fireStatus, "unknown");
    assert.equal(result.changes.some(kind => kind.startsWith("fire")), false);
  }
  assert.equal(state.doorStatus, "closed");
  const legacy = analyzeSample(state, { dust: 18, distance: 12 }, settings, 152_000).next;
  assert.equal(legacy.gasSensor, null); assert.equal(legacy.gasAdc, null); assert.equal(legacy.gasVoltageV, null);
});
test("MQ-135의 0과 실패 출력으로 이전 화재 경보를 해제하지 않는다", () => {
  const risk = { ...emptySensor, fireStatus: "risk" as const, aboveSince: 1, belowSince: 1 };
  for (const gasAdc of [0, 1023, null]) {
    const result = analyzeSample(risk, { dust: null, distance: null, gasSensor: "MQ-135", gasAdc, gasVoltageV: gasAdc === null ? null : gasAdc * 5 / 1023 }, settings, 100_000);
    assert.equal(result.next.fireStatus, "risk");
    assert.equal(result.next.aboveSince, null); assert.equal(result.next.belowSince, null);
    assert.deepEqual(result.changes, []);
  }
});

test("GP2Y1014AU0F 원시 전압은 농도나 화재 판정으로 사용하지 않는다", () => {
  let state = { ...emptySensor };
  for (let now = 100_000; now <= 150_000; now += 2000) {
    const result = analyzeSample(state, { dust: 5000, distance: 12, dustSensor: "GP2Y1014AU0F", dustVoltageV: 4.9 }, settings, now);
    state = result.next;
    assert.equal(state.dust, null);
    assert.equal(state.fireStatus, "unknown");
    assert.equal(state.dustVoltageV, 4.9);
    assert.equal(result.changes.some(kind => kind.startsWith("fire")), false);
  }
  assert.equal(state.doorStatus, "closed");
  const restored = analyzeSample(state, { dust: 18, distance: 12 }, settings, 152_000).next;
  assert.equal(restored.dustSensor, null);
  assert.equal(restored.dustVoltageV, null);
});
test("원시 전압의 낮은 수치나 실패로 이전 센서의 경보를 해제하지 않는다", () => {
  const risk = { ...emptySensor, fireStatus: "risk" as const };
  for (const dustVoltageV of [0, null]) {
    const result = analyzeSample(risk, { dust: null, distance: null, dustSensor: "GP2Y1014AU0F", dustVoltageV }, settings, 100_000);
    assert.equal(result.next.fireStatus, "risk");
    assert.deepEqual(result.changes, []);
  }
});

test("자정을 넘는 안심 시간은 시작 요일을 따른다", () => {
  const s = { ...settings, quietWindows: [window({ days: [1] })] };
  assert.equal(isQuietTime(s, at("2026-11-16T22:00:00")), true);
  assert.equal(isQuietTime(s, at("2026-11-17T06:59:59")), true);
  assert.equal(isQuietTime(s, at("2026-11-17T07:00:00")), false);
  assert.equal(isQuietTime(s, at("2026-11-16T06:59:59")), false);
  assert.equal(isQuietTime(s, at("2026-11-17T22:00:00")), false);
});
test("낮 시간과 꺼진 알림을 구분한다", () => {
  const s = { ...settings, quietWindows: [window({ start: "09:00", end: "17:00", days: [1] })] };
  assert.equal(isQuietTime(s, at("2026-11-16T09:00:00")), true);
  assert.equal(isQuietTime(s, at("2026-11-16T17:00:00")), false);
  assert.equal(isQuietTime({ ...s, quietEnabled: false }, at("2026-11-16T12:00:00")), false);
  assert.equal(isQuietTime({ ...s, doorAlerts: false }, at("2026-11-16T12:00:00")), false);
});
test("여러 안심 시간 중 하나만 해당해도 적용한다", () => {
  const s = { ...settings, quietWindows: [window({ id: "morning", start: "07:00", end: "09:00", days: [1] }), window({ id: "afternoon", start: "15:00", end: "19:00", days: [1] })] };
  assert.equal(isQuietTime(s, at("2026-11-16T08:00:00")), true);
  assert.equal(isQuietTime(s, at("2026-11-16T16:00:00")), true);
  assert.equal(isQuietTime(s, at("2026-11-16T12:00:00")), false);
});
test("개별로 끈 시간과 빈 시간 목록은 적용하지 않는다", () => {
  assert.equal(isQuietTime({ ...settings, quietWindows: [window({ enabled: false })] }, at("2026-11-16T23:00:00")), false);
  assert.equal(isQuietTime({ ...settings, quietWindows: [] }, at("2026-11-16T23:00:00")), false);
});
test("겹치는 시간을 목록으로 찾고 감지 여부는 하나의 참값으로 반환한다", () => {
  const s = { ...settings, quietWindows: [window({ id: "a" }), window({ id: "b", start: "23:00", end: "06:00" })] };
  assert.equal(activeQuietWindows(s, at("2026-11-16T23:30:00")).length, 2);
  assert.equal(isQuietTime(s, at("2026-11-16T23:30:00")), true);
});
test("토요일 밤에서 일요일 아침으로 넘어가도 시작 요일을 따른다", () => {
  const s = { ...settings, quietWindows: [window({ days: [6] })] };
  assert.equal(isQuietTime(s, at("2026-11-22T06:00:00")), true);
  assert.equal(isQuietTime(s, at("2026-11-22T22:00:00")), false);
});
test("자정에 끝나는 시간의 종료 경계를 제외한다", () => {
  const s = { ...settings, quietWindows: [window({ start: "20:00", end: "00:00", days: [1] })] };
  assert.equal(isQuietTime(s, at("2026-11-16T23:59:59")), true);
  assert.equal(isQuietTime(s, at("2026-11-17T00:00:00")), false);
});
test("기존 단일 안심 시간을 잃지 않고 목록으로 읽는다", () => {
  const legacy = { ...settings, quietWindows: undefined, quietStart: "23:15", quietEnd: "06:45", quietDays: [1, 3], quietEnabled: false };
  const result = normalizeHomeSettings(legacy);
  assert.equal(result.quietWindows.length, 1);
  assert.equal(result.quietEnabled, false);
  assert.deepEqual(result.quietWindows[0], { id: "existing", name: "기존 안심 시간", enabled: true, start: "23:15", end: "06:45", days: [1, 3] });
  assert.equal(legacy.quietWindows, undefined);
});
test("새 목록이 있으면 과거 시간보다 우선하며 빈 목록도 유지한다", () => {
  const result = normalizeHomeSettings({ ...settings, quietWindows: [], quietStart: "22:00", quietEnd: "07:00", quietDays: [1] });
  assert.deepEqual(result.quietWindows, []);
});
test("기본 설정과 배열을 호출자끼리 공유하지 않는다", () => {
  const first = normalizeHomeSettings(), second = normalizeHomeSettings();
  first.quietWindows[0].days.pop();
  assert.equal(second.quietWindows[0].days.length, 7);
  assert.equal(defaultSettings.quietWindows[0].days.length, 7);
});
test("반복 요일은 월요일부터 읽기 쉽게 표시한다", () => {
  assert.equal(quietDaysLabel([0, 1, 2, 3, 4, 5, 6]), "매일");
  assert.equal(quietDaysLabel([1, 2, 3, 4, 5]), "월~금");
  assert.equal(quietDaysLabel([0, 6]), "토·일");
});
test("한국 날짜의 자정 경계를 사용한다", () => {
  assert.equal(kstDay("2026-11-15T14:59:59Z"), "2026-11-15");
  assert.equal(kstDay("2026-11-15T15:00:00Z"), "2026-11-16");
});
test("먼지 수치의 짧은 급등만으로 화재 의심으로 판단하지 않는다", () => {
  const high = analyzeSample(emptySensor, { dust: 200, distance: 12 }, settings, 100_000);
  assert.equal(high.next.fireStatus, "watch");
  const normal = analyzeSample(high.next, { dust: 18, distance: 12 }, settings, 102_000);
  assert.equal(normal.next.fireStatus, "normal");
  assert.deepEqual(normal.changes, []);
});
test("높은 먼지 수치가 지속된 경우 한 번만 화재 의심을 기록한다", () => {
  let state = { ...emptySensor };
  let alerts = 0;
  for (let i = 0; i <= 8; i++) {
    const result = analyzeSample(state, { dust: 200, distance: 12 }, settings, 100_000 + i * 2000);
    state = result.next; alerts += result.changes.filter(k => k === "fire_risk").length;
  }
  assert.equal(state.fireStatus, "risk"); assert.equal(alerts, 1);
});
test("연결 공백은 지속 감지 시간으로 세지 않는다", () => {
  const first = analyzeSample(emptySensor, { dust: 200, distance: 12 }, settings, 100_000);
  const later = analyzeSample(first.next, { dust: 200, distance: 12 }, settings, 120_000);
  assert.equal(later.next.fireStatus, "watch"); assert.deepEqual(later.changes, []);
});
test("센서 실패는 정상으로 바꾸지 않으며 진행 중인 경보를 유지한다", () => {
  const invalid = analyzeSample(emptySensor, { dust: null, distance: null }, settings, 100_000);
  assert.equal(invalid.next.fireStatus, "unknown"); assert.equal(invalid.next.doorStatus, "unknown");
  const risk = analyzeSample({ ...emptySensor, fireStatus: "risk" }, { dust: null, distance: null }, settings, 100_000);
  assert.equal(risk.next.fireStatus, "risk"); assert.equal(risk.changes.includes("fire_clear"), false);
});
test("화재 의심은 낮은 수치도 지속되어야 해제된다", () => {
  let state = { ...emptySensor, fireStatus: "risk" as const } as typeof emptySensor;
  let cleared = 0;
  for (let i = 0; i <= 6; i++) {
    const result = analyzeSample(state, { dust: 18, distance: 12 }, settings, 100_000 + i * 2000);
    state = result.next; cleared += result.changes.filter(k => k === "fire_clear").length;
  }
  assert.equal(state.fireStatus, "normal"); assert.equal(cleared, 1);
});
test("현관문은 안정된 두 측정값을 확인하고 첫 닫힘은 활동으로 세지 않는다", () => {
  const first = analyzeSample(emptySensor, { dust: 18, distance: 12 }, settings, 100_000);
  const baseline = analyzeSample(first.next, { dust: 18, distance: 12 }, settings, 102_000);
  assert.equal(baseline.next.doorStatus, "closed"); assert.deepEqual(baseline.changes, []);
  const candidate = analyzeSample(baseline.next, { dust: 18, distance: 58 }, settings, 104_000);
  assert.equal(candidate.next.doorStatus, "closed");
  const opened = analyzeSample(candidate.next, { dust: 18, distance: 58 }, settings, 106_000);
  assert.equal(opened.next.doorStatus, "open"); assert.deepEqual(opened.changes, ["door_open"]);
  const repeated = analyzeSample(opened.next, { dust: 18, distance: 58 }, settings, 108_000);
  assert.deepEqual(repeated.changes, []);
});
test("잘못된 시간·요일·기준값은 저장하지 않는다", () => {
  assert.equal(Boolean(validateHomeSettings(settings).value), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ start: "22:00", end: "22:00" })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ days: [] })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ start: "24:00" })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ days: [7] })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ days: ["1"] as unknown as number[] })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, sirenSeconds: 90 }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, sustainedSeconds: 5.5 }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, dustThreshold: Number.NaN }).error), true);
});
test("안심 시간은 최대 개수 안에서 고유한 번호와 이름을 가진다", () => {
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window(), window()] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ name: " " })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: [window({ name: "가".repeat(25) })] }).error), true);
  assert.equal(Boolean(validateHomeSettings({ ...settings, quietWindows: Array.from({ length: maxQuietWindows + 1 }, (_, i) => window({ id: `window-${i}` })) }).error), true);
  assert.equal(validateHomeSettings({ ...settings, quietWindows: [] }).value?.quietWindows.length, 0);
});
test("요일 중복을 정리하고 시간 이름의 바깥 공백을 지운다", () => {
  const result = validateHomeSettings({ ...settings, quietWindows: [window({ name: " 밤 시간 ", days: [3, 1, 3] })] });
  assert.equal(result.value?.quietWindows[0].name, "밤 시간");
  assert.deepEqual(result.value?.quietWindows[0].days, [1, 3]);
});
