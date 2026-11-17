import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, MAX_POINTS, MAX_EVENTS, clone, kstParts, inWindows, validateSettings, gasReady, parseFrame, boundedPush, eventRecord } from "../streamlit_ui/model.mjs";
import { DistanceAnalysis } from "../streamlit_ui/analysis.mjs";
import { UsbConnection } from "../streamlit_ui/serial.mjs";
import { ZiponApp } from "../streamlit_ui/app.mjs";
import { installFakeUsb } from "./fake-v4-serial.mjs";

const kst = value => Date.parse(value + "+09:00");
const settings = () => { const s = clone(DEFAULT_SETTINGS); s.intrusion.enabled = true; s.intrusion.holdSeconds = s.intrusion.recoverySeconds = 1; return s; };
const point = distanceCm => ({ distanceCm });
const wall = kst("2026-11-16T12:00:00");
const advance = (a, s, values, start = 0, time = wall) => values.map((d, n) => a.update(point(d), s, time + n * 1000, start + n * 1000)).at(-1);

test("V4 기본값은 실제 측정과 예열·출입 감시를 만들어 내지 않는다", () => {
  assert.equal(gasReady(DEFAULT_SETTINGS), false); assert.equal(DEFAULT_SETTINGS.intrusion.enabled, false);
  const s = clone(DEFAULT_SETTINGS); s.quietWindows[0].days.pop(); assert.equal(DEFAULT_SETTINGS.quietWindows[0].days.length, 7);
});
test("시간표는 한국 시간·자정 넘김의 시작 요일·종료 제외를 따른다", () => {
  const windows = [{ enabled: true, start: "23:00", end: "06:00", days: [6] }];
  assert(inWindows(windows, kst("2026-11-21T23:00:00")));
  assert(inWindows(windows, kst("2026-11-22T05:59:59")));
  assert(!inWindows(windows, kst("2026-11-22T06:00:00")));
  assert(!inWindows(windows, kst("2026-11-20T23:30:00")));
  assert.equal(kstParts(kst("2026-11-22T00:00:00")).date, "2026-11-22");
});
test("낮 시간·개별 끄기·겹친 시간·빈 목록을 구분한다", () => {
  const w = { enabled: true, start: "09:00", end: "18:00", days: [1] };
  assert(inWindows([w, w], wall)); assert(!inWindows([{ ...w, enabled: false }], wall)); assert(!inWindows([], wall));
  assert(!inWindows([w], kst("2026-11-16T18:00:00")));
});
test("가스 기준의 순서·범위·정수·시간 검증", () => {
  const s = settings(); s.gas = { warmupConfirmed: true, baseline: 100, recovery: 150, threshold: 200, holdSeconds: 5, recoverySeconds: 10 };
  assert(gasReady(validateSettings(s)));
  for (const change of [{ baseline: 0 }, { threshold: 1023 }, { recovery: 200 }, { holdSeconds: 4 }, { recoverySeconds: 1.5 }]) assert.throws(() => validateSettings({ ...s, gas: { ...s.gas, ...change } }));
});
test("잘못된 시간표·반복 요일·중복 식별값·최대 20개 초과 거절", () => {
  for (const change of [{ days: [] }, { days: [7] }, { end: "22:00" }, { start: "25:00" }]) {
    const s = settings(); Object.assign(s.quietWindows[0], change); assert.throws(() => validateSettings(s));
  }
  const s = settings(); s.quietWindows.push(clone(s.quietWindows[0])); assert.throws(() => validateSettings(s));
  s.quietWindows = Array.from({ length: 21 }, (_, n) => ({ ...s.quietWindows[0], id: `t-${n}` })); assert.throws(() => validateSettings(s));
});
test("첫 이탈·처음의 히스테리시스 중간값을 출입으로 세지 않는다", () => {
  const s = settings(), a = new DistanceAnalysis();
  assert.equal(advance(a, s, [50, 50, 50, 50]).alarm, false);
  a.reset(); const band = s.intrusion.baselineCm + s.intrusion.deltaCm * .8;
  assert.equal(advance(a, s, [band, band, band]).changed, null);
  assert.equal(a.normalSeen, false);
});
test("초기 정상 거리 이후 지속 이탈만 한 번 감지", () => {
  const s = settings(), a = new DistanceAnalysis(); advance(a, s, [12, 12, 12]);
  assert.equal(a.normalSeen, true);
  assert.equal(advance(a, s, [50, 50], 3000).alarm, false);
  const r = advance(a, s, [50, 50], 5000); assert.equal(r.alarm, true);
  assert.equal(advance(a, s, [50, 50], 7000).event, null);
});
test("거리 노이즈·짧은 이탈은 경보 아님", () => {
  const s = settings(), a = new DistanceAnalysis(); advance(a, s, [12, 12, 12]);
  assert.equal(advance(a, s, [80, 12, 12, 12], 3000).alarm, false);
});
test("측정 실패는 정상 복귀가 아니며 첫 복구 이탈도 경보 아님", () => {
  const s = settings(), a = new DistanceAnalysis(); advance(a, s, [12, 12, 12, 50, 50, 50]);
  assert(a.alarm);
  const failed = a.update(point(null), s, wall, 6000); assert.equal(failed.event, "intrusion_stopped");
  assert.equal(advance(a, s, [50, 50, 50], 7000).alarm, false);
});
test("허용 시간 안의 이탈은 경보 아님·허용 시간 시작은 정상 판정과 별개", () => {
  const s = settings(); s.intrusion.allowedWindows = [{ enabled: true, start: "09:00", end: "18:00", days: [1] }];
  const a = new DistanceAnalysis(); assert.equal(advance(a, s, [12, 12, 12, 50, 50, 50]).alarm, false);
  const b = new DistanceAnalysis(); advance(b, settings(), [12, 12, 12, 50, 50, 50]); assert(b.alarm);
  const r = b.update(point(50), s, wall, 6000); assert.equal(r.alarm, false); assert.equal(r.event, "intrusion_clear");
});
test("복귀 뒤 재이탈은 반복 방지 시간까지 재경보하지 않는다", () => {
  const s = settings(), a = new DistanceAnalysis(); advance(a, s, [12, 12, 12, 50, 50, 50]); const until = a.cooldownUntil;
  advance(a, s, [12, 12, 12], 6000); assert(!a.alarm);
  advance(a, s, [50, 50, 50], 9000); assert(!a.alarm);
  assert.equal(a.update(point(50), s, wall, until).event, "intrusion_alert");
});
test("그래프 600개·새 이벤트 2000개 제한과 당시 값 보존", () => {
  const values = []; for (let n = 0; n < 900; n++) boundedPush(values, n, MAX_POINTS);
  assert.equal(values.length, 600); assert.equal(values[0], 300);
  const events = []; for (let n = 0; n < 2100; n++) boundedPush(events, eventRecord("door_open", { gasRaw: 120, distanceCm: 25, led: false, buzzer: true }, "격리 검사", n * 1000), MAX_EVENTS);
  assert.equal(events.length, 2000); assert.equal(events[0].gas_raw, 120); assert.equal(events[0].buzzer, true);
});

Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
test("첫 측정 전달 직전에도 빈 화면은 오류 없이 제어를 잠근다", () => {
  const control = { disabled: false };
  const view = Object.assign(Object.create(ZiponApp.prototype), {
    main: {}, root: { querySelectorAll: selector => selector === "[data-control]" ? [control] : [], querySelector: () => null },
    data: {}, settings: clone(DEFAULT_SETTINGS), last: null, usb: { fresh: true }, connection: { state: "connected" }, lease: true,
  });
  assert.doesNotThrow(() => view.updateLive()); assert.equal(control.disabled, true);
  view.last = { gasRaw: 120, distanceCm: 12, gasState: "disabled", config: 0, led: false, buzzer: false };
  assert.doesNotThrow(() => view.updateLive()); assert.equal(control.disabled, false);
});
async function fixture() {
  const serial = installFakeUsb({ install: false }); let now = 1000;
  const samples = [], statuses = [], events = [];
  const usb = new UsbConnection({ serial, now: () => now, onSample: p => samples.push(p), onStatus: s => statuses.push(s), onEvent: (...v) => events.push(v) });
  await usb.connect(); await new Promise(resolve => setImmediate(resolve));
  return { usb, serial, port: serial.port, samples, statuses, events, advance: n => { now += n; }, settle: () => new Promise(resolve => setImmediate(resolve)) };
}
test("9600 접속·잘린 청크 재조립·단일 reader와 새 값 수신", async () => {
  const f = await fixture();
  try { assert.equal(f.port.options.baudRate, 9600); assert(f.usb.ready); f.port.sample(); await f.settle(); assert(f.usb.fresh); assert.equal(f.samples.length, 1); await assert.rejects(f.usb.connect()); assert.equal(f.port.opens, 1); }
  finally { await f.usb.destroy(); }
});
test("중복 순서·다른 연결의 수신은 측정 수명을 늘리지 않음", async () => {
  const f = await fixture();
  try { const frame = f.port.sample(); await f.settle(); f.advance(1000); f.port.push(frame); f.port.sample({ session: "b".repeat(16) }); await f.settle(); assert.equal(f.samples.length, 1); assert.equal(f.usb.receivedAt, 1000); }
  finally { await f.usb.destroy(); }
});
test("보드 응답·마지막 출력 보고는 별개이고 요청은 한 번에 하나", async () => {
  const f = await fixture();
  try {
    f.port.sample(); await f.settle(); const pending = f.usb.command("manual", { target: "led", on: true, seconds: 2 });
    await assert.rejects(f.usb.command("manual", { target: "buzzer", on: true, seconds: 2 }));
    assert.equal((await pending).applied, true); assert.equal(f.usb.lastSample.led, false);
    f.port.sample(); await f.settle(); assert.equal(f.usb.lastSample.led, true);
  } finally { await f.usb.destroy(); }
});
test("오래된 측정으로 요청하지 않고 복구 때 지속 판정을 끊음", async () => {
  const f = await fixture();
  try { f.port.sample(); await f.settle(); f.advance(4000); await assert.rejects(f.usb.command("manual", { target: "led", on: true, seconds: 2 })); f.port.sample(); await f.settle(); assert(f.events.some(e => e[0] === "stale")); assert(f.usb.fresh); }
  finally { await f.usb.destroy(); }
});
test("잘못된·긴 JSON과 모순된 출력은 버린 뒤 정상 줄 복구", async () => {
  const f = await fixture();
  try {
    f.port.push("x".repeat(900) + "\n"); f.port.push("{bad}\n"); f.port.sample({ gasRaw: 5000 }); f.port.sample({ led: true, ledSource: "off" });
    f.port.sample(); await f.settle(); assert.equal(f.samples.length, 1); assert(f.events.filter(e => e[0] === "protocol_error").length >= 4);
    assert.throws(() => parseFrame("ZIPON_AUTO_V3"));
  } finally { await f.usb.destroy(); }
});
test("요청 거절은 성공 처리하지 않고 늦은 ACK도 무시", async () => {
  const f = await fixture();
  try {
    f.port.sample(); await f.settle(); f.port.nextAck = "reject";
    await assert.rejects(f.usb.command("manual", { target: "led", on: true, seconds: 2 }));
    f.port.nextAck = "drop"; const promise = f.usb.command("manual", { target: "led", on: true, seconds: 2 });
    await assert.rejects(promise, /응답이 없어요/); assert.equal(f.usb.pending.size, 0);
    f.port.push({ type: "ack", protocol: "ZIPON_USB_V4", session: f.usb.session, id: "00000002", applied: true, reason: "applied" }); await f.settle(); assert.equal(f.usb.lastSample.led, false);
  } finally { await f.usb.destroy(); }
});
test("USB 해제는 작업·잠금을 정리하고 재연결은 새 세션", async () => {
  const f = await fixture();
  try {
    const session = f.usb.session; f.port.sample(); await f.settle();
    await f.usb.close(); assert(!f.port.readable.locked && !f.port.writable.locked); assert.equal(f.port.closes, 1); assert(!f.usb.fresh);
    await f.usb.connect(true); await f.settle(); assert.notEqual(f.usb.session, session); assert.equal(f.serial.chooserCalls, 1); assert.equal(f.port.opens, 2);
  } finally { await f.usb.destroy(); }
});
test("읽기 오류·보드 재부팅은 연결 종료이며 자동 재접속하지 않음", async () => {
  const f = await fixture();
  try { f.port.sample(); await f.settle(); f.port.fail(); await f.settle(); await f.usb.closing; assert(!f.usb.port); assert.equal(f.port.opens, 1); }
  finally { await f.usb.destroy(); }
  const b = await fixture();
  try { b.port.push({ type: "boot", protocol: "ZIPON_USB_V4" }); await b.settle(); await b.usb.closing; assert(!b.usb.port); assert(b.events.some(e => e[0] === "boot")); }
  finally { await b.usb.destroy(); }
});
test("권한 거절·미지원·잘못된 스케치 시간 초과 안내", async () => {
  const serial = installFakeUsb({ install: false }); serial.deny = true;
  const usb = new UsbConnection({ serial }); await assert.rejects(usb.connect(), /취소/); await usb.destroy();
  const noUsb = new UsbConnection({ serial: null }); await assert.rejects(noUsb.connect(), /데스크톱/); await noUsb.destroy();
  const f = await fixture();
  try { await f.usb.close(); f.port.skipReady = true; await f.usb.connect(true); f.advance(9000); f.usb.tick(); await f.usb.closing; assert(!f.usb.ready); assert(f.statuses.at(-1).message.includes("V4")); }
  finally { await f.usb.destroy(); }
});
