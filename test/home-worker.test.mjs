import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHomeHarness } from "./home-harness.mjs";

let home, deviceToken;
const allDays = [0, 1, 2, 3, 4, 5, 6];
const overlap = [
  { id: "am", name: "오전", start: "00:00", end: "12:00", days: allDays, enabled: true },
  { id: "pm", name: "오후", start: "12:00", end: "00:00", days: allDays, enabled: true },
  { id: "am-again", name: "겹치는 오전", start: "00:00", end: "12:00", days: allDays, enabled: true },
  { id: "pm-again", name: "겹치는 오후", start: "12:00", end: "00:00", days: allDays, enabled: true },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
before(async () => { home = await createHomeHarness(); });
after(async () => { await home?.close(); });
const snapshot = async () => { const response = await home.family("/snapshot"); assert.equal(response.status, 200); return response.json(); };
const telemetry = (id, dust = 18, distance = 12, token = deviceToken) => home.fetch("/api/device/telemetry", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ sampleId: id, dustUgM3: dust, distanceCm: distance }) });
const command = (action, id = crypto.randomUUID()) => home.family("/commands", { method: "POST", body: JSON.stringify({ action, id }) });
const ack = (id, status) => home.fetch(`/api/device/commands/${id}/ack`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ status }) });

test("비밀번호 없이 가족 기록·설정·기기·제어에 접근할 수 없다", async () => {
  const access = await home.fetch("/api/home/access");
  assert.deepEqual(await access.json(), { configured: true });
  for (const [path, method] of [["snapshot", "GET"], ["events", "GET"], ["settings", "PUT"], ["device", "POST"], ["commands", "POST"], ["alerts/read", "PATCH"]]) {
    const response = await home.fetch(`/api/home/${path}`, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(response.status, 401, path);
  }
  const oldHeader = await home.fetch("/api/home/snapshot", { headers: { "x-zipon-demo": "a".repeat(64) } });
  assert.equal(oldHeader.status, 401);
  assert.equal((await home.family("/unlock", { method: "POST" })).status, 200);
  assert.equal((await home.family("/simulate", { method: "POST", body: '{"action":"door"}' })).status, 404);
});
test("처음 연 가족 공간은 예시 측정·기록 없이 연결 전 상태다", async () => {
  const s = await snapshot();
  assert.equal(s.online, false); assert.equal(s.sensor.dust, null); assert.equal(s.sensor.distance, null);
  assert.equal(s.sensor.fireStatus, "unknown"); assert.equal(s.sensor.doorStatus, "unknown");
  assert.equal(s.todayOpenCount, 0); assert.deepEqual(s.events, []); assert.deepEqual(s.alerts, []);
  assert.equal(Object.hasOwn(s, "demo"), false); assert.equal(Object.hasOwn(s.sensor, "demoOnline"), false);
});
test("기존 단일 시간을 읽어도 저장 원문과 기록을 덮어쓰지 않는다", async () => {
  const { quietWindows, ...base } = (await snapshot()).settings;
  const legacy = { ...base, quietStart: "23:15", quietEnd: "06:45", quietDays: [1, 3], quietEnabled: false };
  await home.db.prepare("UPDATE home_settings SET value = ? WHERE scope = 'family'").bind(JSON.stringify(legacy)).run();
  const s = await snapshot();
  assert.equal(s.settings.quietWindows[0].start, "23:15");
  assert.deepEqual(s.settings.quietWindows[0].days, [1, 3]);
  assert.equal(s.settings.quietEnabled, false);
  const row = await home.db.prepare("SELECT value FROM home_settings WHERE scope = 'family'").first();
  assert.deepEqual(JSON.parse(row.value), legacy);
  assert.ok(quietWindows.length);
});
test("여러 시간의 저장·수정·삭제가 다시 읽어도 유지된다", async () => {
  const settings = { ...(await snapshot()).settings, quietEnabled: true, quietWindows: overlap };
  const response = await home.family("/settings", { method: "PUT", body: JSON.stringify(settings) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.quietWindows.length, 4);
  const row = await home.db.prepare("SELECT value FROM home_settings WHERE scope = 'family'").first();
  assert.deepEqual(JSON.parse(row.value).quietWindows, overlap);
  const next = { ...settings, quietWindows: [{ ...overlap[0], name: "바꾼 시간", enabled: false }, overlap[1]] };
  assert.equal((await home.family("/settings", { method: "PUT", body: JSON.stringify(next) })).status, 200);
  assert.deepEqual((await snapshot()).settings.quietWindows, next.quietWindows);
  assert.equal((await home.family("/settings", { method: "PUT", body: JSON.stringify({ ...settings, quietWindows: [] }) })).status, 200);
  assert.deepEqual((await snapshot()).settings.quietWindows, []);
  assert.equal((await home.family("/settings", { method: "PUT", body: JSON.stringify(settings) })).status, 200);
});
test("잘못된 시간 목록은 저장하지 않고 이전 설정을 유지한다", async () => {
  const settings = (await snapshot()).settings;
  for (const quietWindows of [[{ ...overlap[0], end: "00:00" }], [overlap[0], overlap[0]], [{ ...overlap[0], days: [] }], [{ ...overlap[0], start: "24:00" }]]) {
    const response = await home.family("/settings", { method: "PUT", body: JSON.stringify({ ...settings, quietWindows }) });
    assert.equal(response.status, 400);
  }
  assert.deepEqual((await snapshot()).settings, settings);
});
test("기기 키는 한 번 발급하고 원문 대신 해시만 보관한다", async () => {
  const response = await home.family("/device", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  deviceToken = (await response.json()).token;
  assert.match(deviceToken, /^[a-f0-9]{64}$/);
  const row = await home.db.prepare("SELECT token_hash FROM home_devices WHERE scope = 'family'").first();
  assert.notEqual(row.token_hash, deviceToken);
  const s = await snapshot(); assert.equal(s.device.paired, true); assert.equal(s.online, false);
  assert.equal(JSON.stringify(s).includes(deviceToken), false);
  assert.equal((await telemetry("bad-key", 18, 12, home.password)).status, 401);
  assert.equal((await command("start")).status, 409);
});
test("측정 실패는 null로 저장하고 정상이라고 판단하지 않는다", async () => {
  assert.equal((await telemetry("null:1", null, null)).status, 200);
  const s = await snapshot();
  assert.equal(s.online, true); assert.equal(s.sensor.fireStatus, "unknown"); assert.equal(s.sensor.doorStatus, "unknown");
  assert.equal((await telemetry("bad:1", -1, 12)).status, 400);
});
test("겹치는 안심 시간에도 문 열림 기록과 알림은 각각 한 번만 남는다", async () => {
  assert.equal((await telemetry("door:1")).status, 200);
  await sleep(1100); assert.equal((await telemetry("door:2")).status, 200);
  assert.equal((await snapshot()).sensor.doorStatus, "closed");
  assert.equal((await telemetry("door:3", 18, 58)).status, 200);
  await sleep(1100); assert.equal((await telemetry("door:4", 18, 58)).status, 200);
  assert.equal((await telemetry("door:4", 18, 58)).status, 200);
  assert.equal((await telemetry("door:5", 18, 58)).status, 200);
  const s = await snapshot();
  assert.equal(s.sensor.doorStatus, "open"); assert.equal(s.todayOpenCount, 1);
  assert.equal(s.alerts.filter(row => row.kind === "door_open").length, 1);
  assert.equal(s.events.filter(row => row.kind === "door_open").length, 1);
  assert.equal(s.events.find(row => row.kind === "door_open").emergency, 1);
  const persisted = await home.db.prepare("SELECT COUNT(*) AS count FROM home_alerts WHERE scope = 'family' AND kind = 'door_open'").first();
  assert.equal(persisted.count, 1);
});
test("먼지 지속 감지와 실패 이후의 경보 유지가 실제 수신 경로에서도 적용된다", async () => {
  await telemetry("fire:1", 200, 58);
  assert.equal((await snapshot()).sensor.fireStatus, "watch");
  await home.db.prepare("UPDATE home_state SET value = json_set(value, '$.aboveSince', ?) WHERE scope = 'family'").bind(Date.now() - 11000).run();
  await telemetry("fire:2", 200, 58);
  await telemetry("fire:3", 200, 58);
  await telemetry("fire:4", null, null);
  const s = await snapshot(); assert.equal(s.sensor.fireStatus, "risk");
  assert.equal(s.alerts.filter(row => row.kind === "fire_risk").length, 1);
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const events = await home.family(`/events?date=${date}&type=fire`);
  assert.equal(events.status, 200); assert.equal((await events.json()).total, 1);
  assert.equal((await home.family("/events?date=2026-02-30")).status, 400);
});
test("사이렌은 기기 응답 전에는 요청 대기이며 완료 응답도 순서를 검사한다", async () => {
  const response = await command("start"); assert.equal(response.status, 200);
  const s = await response.json(), id = s.command.id;
  assert.equal(s.command.status, "pending"); assert.equal(s.command.started_at, null);
  assert.equal((await command("start")).status, 409);
  const pending = await home.fetch("/api/device/commands", { headers: { authorization: `Bearer ${deviceToken}` } });
  assert.equal((await pending.json()).command.id, id);
  assert.equal((await ack(id, "completed")).status, 409);
  assert.equal((await ack(id, "started")).status, 200);
  assert.equal((await (await ack(id, "started")).json()).alreadyApplied, true);
  assert.equal((await snapshot()).command.status, "acknowledged");
  const stop = await command("stop"), stopped = await stop.json();
  assert.equal(stopped.command.status, "pending");
  assert.equal((await ack(stopped.command.id, "started")).status, 400);
  assert.equal((await ack(stopped.command.id, "completed")).status, 200);
  assert.equal((await snapshot()).command.status, "completed");
  assert.equal((await (await ack(stopped.command.id, "completed")).json()).alreadyApplied, true);
});
test("응답 기한이 지나면 성공이 아니라 기한 만료로 남고 늦은 실행을 거부한다", async () => {
  const s = await (await command("start")).json();
  await home.db.prepare("UPDATE home_commands SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), s.command.id).run();
  assert.equal((await snapshot()).command.status, "expired");
  assert.equal((await ack(s.command.id, "started")).status, 409);
});
test("읽은 알림과 기록 조회가 저장된 행과 일치한다", async () => {
  const s = await snapshot(), id = s.alerts[0].id;
  assert.equal((await home.family("/alerts/read", { method: "PATCH", body: JSON.stringify({ ids: [id] }) })).status, 200);
  const row = await home.db.prepare("SELECT read_at FROM home_alerts WHERE id = ?").bind(id).first();
  assert.ok(row.read_at);
  assert.ok((await snapshot()).alerts.find(alert => alert.id === id).read_at);
});
test("GP2Y1014AU0F 원시 전압만 저장하며 이전 경보와 알림을 임의로 바꾸지 않는다", async () => {
  const before = await snapshot();
  const send = body => home.fetch("/api/device/telemetry", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: JSON.stringify(body) });
  const valid = { sampleId: "raw:1", dustSensor: "GP2Y1014AU0F", dustVoltageV: 0.623, dustUgM3: null, distanceCm: 12 };
  for (const invalid of [
    { ...valid, dustUgM3: 18 }, { ...valid, dustVoltageV: -0.1 }, { ...valid, dustVoltageV: 5.6 },
    { ...valid, dustVoltageV: "0.6" }, { ...valid, dustVoltageV: undefined },
    { ...valid, dustSensor: "unknown" }, { ...valid, dustSensor: undefined },
  ]) assert.equal((await send(invalid)).status, 400);
  assert.equal((await send(valid)).status, 200);
  const s = await snapshot();
  assert.equal(s.sensor.dustSensor, "GP2Y1014AU0F");
  assert.equal(s.sensor.dustVoltageV, 0.623);
  assert.equal(s.sensor.dust, null);
  assert.equal(s.sensor.fireStatus, "risk");
  assert.deepEqual(s.alerts, before.alerts);
  const persisted = JSON.parse((await home.db.prepare("SELECT value FROM home_state WHERE scope = 'family'").first()).value);
  assert.equal(persisted.dustVoltageV, 0.623);
  assert.equal((await send({ ...valid, sampleId: "raw:2", dustVoltageV: null })).status, 200);
  assert.equal((await snapshot()).sensor.dustVoltageV, null);
});
test("MQ-135는 ADC·전압만 저장하고 과거 경보·알림·설정을 보존한다", async () => {
  const before = await snapshot();
  const settingsBefore = (await home.db.prepare("SELECT value FROM home_settings WHERE scope = 'family'").first()).value;
  const send = body => home.fetch("/api/device/telemetry", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: JSON.stringify(body) });
  const valid = { sampleId: "mq135:1", gasSensor: "MQ-135", gasAdc: 512, gasVoltageV: 2.5024, dustUgM3: null, distanceCm: 12 };
  for (const invalid of [
    { ...valid, dustUgM3: 18 }, { ...valid, dustSensor: "GP2Y1014AU0F", dustVoltageV: 0.6 },
    { ...valid, gasAdc: -1 }, { ...valid, gasAdc: 1024 }, { ...valid, gasAdc: 1.5 },
    { ...valid, gasAdc: "512" }, { ...valid, gasAdc: true }, { ...valid, gasAdc: undefined },
    { ...valid, gasAdc: null }, { ...valid, gasVoltageV: null }, { ...valid, gasVoltageV: undefined },
    { ...valid, gasVoltageV: -0.1 }, { ...valid, gasVoltageV: 5.6 }, { ...valid, gasVoltageV: "2.5" },
    { ...valid, gasSensor: "unknown" }, { ...valid, gasSensor: undefined },
  ]) assert.equal((await send(invalid)).status, 400);
  for (const [index, gasAdc] of [512, 0, 1023, null].entries()) {
    const gasVoltageV = gasAdc === null ? null : Math.round(gasAdc * 5 / 1023 * 10000) / 10000;
    const body = { ...valid, sampleId: `mq135:${index + 1}`, gasAdc, gasVoltageV };
    assert.equal((await send(body)).status, 200);
    assert.equal((await send(body)).status, 200); // A retry never creates another event.
    const s = await snapshot();
    assert.equal(s.sensor.gasSensor, "MQ-135"); assert.equal(s.sensor.gasAdc, gasAdc);
    assert.equal(s.sensor.gasVoltageV, gasVoltageV); assert.equal(s.sensor.dust, null);
    assert.equal(s.sensor.dustVoltageV, null); assert.equal(s.sensor.fireStatus, "risk");
    assert.deepEqual(s.alerts, before.alerts);
    const persisted = JSON.parse((await home.db.prepare("SELECT value FROM home_state WHERE scope = 'family'").first()).value);
    assert.equal(persisted.gasVoltageV, gasVoltageV); assert.equal(persisted.gasAdc, gasAdc);
  }
  assert.equal((await home.db.prepare("SELECT value FROM home_settings WHERE scope = 'family'").first()).value, settingsBefore);
  assert.equal((await home.db.prepare("SELECT COUNT(*) AS n FROM home_commands WHERE status = 'pending'").first()).n, 0);
});
test("연결 키를 바꾸면 이전 키를 거부하고 새 측정 전까지 연결됐다고 표시하지 않는다", async () => {
  const oldToken = deviceToken;
  const response = await home.family("/device", { method: "POST", body: "{}" });
  deviceToken = (await response.json()).token;
  assert.equal((await telemetry("rotated:1", 18, 12, oldToken)).status, 401);
  const s = await snapshot(); assert.equal(s.online, false); assert.equal(s.sensor.lastSeen, null);
  assert.equal((await telemetry("rotated:1")).status, 200);
});
test("15초간 수신이 없으면 실제 상태를 알 수 없는 연결 끊김 상태다", async () => {
  await home.db.prepare("UPDATE home_state SET value = json_set(value, '$.lastSeen', ?) WHERE scope = 'family'").bind(new Date(Date.now() - 16000).toISOString()).run();
  assert.equal((await snapshot()).online, false);
});
test("비밀번호 우회 시도도 제한하고 잠긴 동안 올바른 비밀번호도 비교하지 않는다", async () => {
  const ip = `test-${crypto.randomUUID()}`;
  for (let i = 0; i < 15; i++) {
    const response = await home.fetch("/api/home/snapshot", { headers: { authorization: "Bearer wrong", "cf-connecting-ip": ip } });
    assert.equal(response.status, 401);
  }
  const blocked = await home.family("/unlock", { method: "POST", headers: { "cf-connecting-ip": ip } });
  assert.equal(blocked.status, 429);
  assert.equal((await home.family("/unlock", { method: "POST", headers: { "cf-connecting-ip": `other-${ip}` } })).status, 200);
});
test("가족 비밀번호가 없으면 잠금을 풀거나 기록을 초기화할 수 없다", async () => {
  const blank = await createHomeHarness({ configured: false });
  try {
    assert.deepEqual(await (await blank.fetch("/api/home/access")).json(), { configured: false });
    assert.equal((await blank.family("/unlock", { method: "POST" })).status, 403);
    assert.equal((await blank.family("/snapshot")).status, 403);
    assert.equal((await blank.db.prepare("SELECT COUNT(*) AS count FROM home_settings").first()).count, 0);
  } finally { await blank.close(); }
});
