import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHomeHarness } from "./home-harness.mjs";

let home, token;
let sid = "a".repeat(32), seq = 0;
before(async () => {
  home = await createHomeHarness();
  await home.family("/snapshot");
  token = (await (await home.family("/device", { method: "POST", body: "{}" })).json()).token;
});
after(async () => home?.close());
const snapshot = async () => (await home.family("/snapshot")).json();
const device = (path, body) => home.fetch(`/api/device${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
function packet(number, change = {}) {
  const base = { protocol: "ZIPON_AUTO_V3", sampleId: `${sid}:${number}`, gasSensor: "MQ-135", dustUgM3: null, gasAdc: 100, gasVoltageV: 0.4888, distanceCm: 12,
    board: { session: sid, sequence: number, uptimeMs: number * 2000, configRevision: "0".repeat(16), doorStatus: "unknown", gasStatus: "disabled", gasAlarm: false, ledOn: false, buzzerOn: false, ledSource: "off", buzzerSource: "off", muteSeconds: 0, ledOffSeconds: 0, buzzerOffSeconds: 0 }, boardEvents: [] };
  return { ...base, ...change, board: { ...base.board, ...change.board } };
}
async function send(change = {}) {
  const p = packet(++seq, change), response = await device("/telemetry", p);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return { p, response: await response.json() };
}
const settings = value => home.family("/settings", { method: "PUT", body: JSON.stringify(value) });
const output = (target, action, id = crypto.randomUUID()) => home.family("/outputs", { method: "POST", body: JSON.stringify({ target, action, id }) });
const claim = (id, session = sid) => device(`/outputs/${id}/claim`, { session });
const ack = (id, status = "applied", session = sid) => device(`/outputs/${id}/ack`, { session, status });
const event = (sequence, kind, extras = {}) => ({ sequence, kind, uptimeMs: (seq + 1) * 2000 - 10, gasAdc: 250, distanceCm: 50, ...extras });

test("새 제어도 가족 비밀번호·기기 키를 우회하지 못한다", async () => {
  assert.equal((await home.fetch("/api/home/outputs", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await home.fetch(`/api/device/outputs/${crypto.randomUUID()}/claim`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await output("led", "on")).status, 409);
});
test("V3는 원시 측정·보드 출력·설정 적용 응답을 분리한다", async () => {
  const { response } = await send();
  assert.equal(response.protocol, "ZIPON_AUTO_V3");
  assert.equal(response.config.gasEnabled, false); assert.equal(response.config.doorCalibrated, false);
  assert.deepEqual(response.commands, []);
  const s = await snapshot();
  assert.equal(s.sensor.gasAdc, 100); assert.equal(s.sensor.board.ledOn, false);
  assert.equal(s.sensor.board.configRevision, "0".repeat(16));
  assert.notEqual(s.boardConfig.revision, s.sensor.board.configRevision);
  await send(); assert.equal((await snapshot()).sensor.doorStatus, "unknown");
});
test("V3의 누락·범위 밖·모순된 센서/출력/이벤트를 거부한다", async () => {
  const base = packet(seq + 1);
  const mutations = [
    { protocol: "V4" }, { sampleId: "old" }, { gasAdc: -1 }, { gasVoltageV: null }, { gasAdc: 100.5 }, { dustUgM3: 18 },
    { distanceCm: null, board: { ...base.board, doorStatus: "open" } },
    { gasAdc: 0, gasVoltageV: 0, board: { ...base.board, gasStatus: "below" } },
    { board: { ...base.board, sequence: 0 } }, { board: { ...base.board, gasStatus: "normal" } },
    { board: { ...base.board, gasStatus: "alert", gasAlarm: false } },
    { board: { ...base.board, ledOn: true, ledSource: "off" } }, { board: { ...base.board, muteSeconds: 61 } },
    { board: { ...base.board, gasAlarm: "true" } }, { boardEvents: undefined },
    { boardEvents: [event(1, "gas_alert", { gasAdc: null })] },
    { boardEvents: [event(1, "door_open", { distanceCm: null })] },
    { boardEvents: [event(1, "fire_risk")] },
    { boardEvents: [event(1, "gas_alert", { uptimeMs: base.board.uptimeMs + 1 })] },
    { boardEvents: [event(1, "gas_alert"), event(1, "gas_alert")] },
  ];
  for (const change of mutations) assert.equal((await device("/telemetry", { ...base, ...change })).status, 400, JSON.stringify(change));
  assert.equal((await snapshot()).sensor.board.sequence, seq);
});
test("예열 확인·기준·현재 USB 연결 없는 가스 감시 시작은 저장하지 않는다", async () => {
  const s = (await snapshot()).settings;
  assert.equal((await settings({ ...s, gasEnabled: true })).status, 400);
  assert.equal((await settings({ ...s, gasBaselineAdc: 1000, gasRiseAdc: 100 })).status, 400);
  assert.equal((await settings({ ...s, gasBaselineAdc: 0 })).status, 400);
  assert.equal((await settings({ ...s, gasBaselineAdc: 100, gasEnabled: true, gasWarmupConfirmed: true, gasArmSession: "b".repeat(32) })).status, 409);
  const r = await settings({ ...s, gasBaselineAdc: 100, gasEnabled: true, gasWarmupConfirmed: true, gasArmSession: sid });
  assert.equal(r.status, 200);
  let current = await r.json(); assert.equal(current.boardConfig.gasEnabled, true);
  assert.equal(current.sensor.board.gasStatus, "disabled"); // Saving is not applying.
  await send({ board: { configRevision: current.boardConfig.revision, gasStatus: "below" } });
  current = await snapshot(); assert.equal(current.sensor.board.configRevision, current.boardConfig.revision);
});
test("보드의 자동 경고 이벤트를 재전송해도 기록·알림은 한 번만 남는다", async () => {
  const e = event(1, "gas_alert"), change = { gasAdc: 250, gasVoltageV: 1.2219, board: { gasStatus: "alert", gasAlarm: true, ledOn: true, ledSource: "gas", buzzerOn: true, buzzerSource: "gas" }, boardEvents: [e] };
  const { p } = await send(change); assert.equal((await device("/telemetry", p)).status, 200);
  await send(change);
  const count = await home.db.prepare("SELECT COUNT(*) AS n FROM home_events WHERE kind = 'gas_alert'").first();
  assert.equal(count.n, 1);
  const s = await snapshot(); assert.equal(s.alerts.filter(a => a.kind === "gas_alert").length, 1);
  assert.equal(s.sensor.fireStatus, "unknown"); assert.equal(s.sensor.board.gasAlarm, true);
  assert.match(s.alerts[0].message, /화재 판정은 아니/);
});
test("측정 실패로 출력 경고와 과거 화재 경보를 정상으로 바꾸지 않는다", async () => {
  await home.db.prepare("UPDATE home_state SET value = json_set(value, '$.fireStatus', 'risk') WHERE scope = 'family'").run();
  await send({ gasAdc: null, gasVoltageV: null, distanceCm: null, board: { gasStatus: "fault", gasAlarm: true } });
  const s = await snapshot(); assert.equal(s.sensor.doorStatus, "unknown"); assert.equal(s.sensor.fireStatus, "risk"); assert.equal(s.sensor.board.gasAlarm, true);
  const e = event(2, "gas_below", { gasAdc: 120 });
  await send({ gasAdc: 120, gasVoltageV: 0.5865, board: { gasStatus: "below" }, boardEvents: [e] });
  assert.equal((await snapshot()).sensor.fireStatus, "risk");
});
test("문 자동 반응 기록과 안심 시간 앱 알림을 분리하고 겹쳐도 중복하지 않는다", async () => {
  const s = (await snapshot()).settings;
  const windows = [{ id: "a", name: "오전", enabled: true, start: "00:00", end: "12:00", days: [0,1,2,3,4,5,6] }, { id: "b", name: "오후", enabled: true, start: "12:00", end: "00:00", days: [0,1,2,3,4,5,6] }];
  assert.equal((await settings({ ...s, quietWindows: windows })).status, 200);
  const e = event(3, "door_open"); await send({ distanceCm: 50, board: { doorStatus: "open" }, boardEvents: [e] });
  await send({ distanceCm: 50, board: { doorStatus: "open" }, boardEvents: [e] });
  let current = await snapshot(); assert.equal(current.todayOpenCount, 1); assert.equal(current.alerts.filter(a => a.kind === "door_open").length, 1);
  assert.equal((await settings({ ...current.settings, doorAlerts: false })).status, 200);
  await send({ boardEvents: [event(4, "door_closed", { distanceCm: 12 })], board: { doorStatus: "closed" } });
  await send({ boardEvents: [event(5, "door_open")], distanceCm: 50, board: { doorStatus: "open" } });
  current = await snapshot(); assert.equal(current.todayOpenCount, 2); assert.equal(current.alerts.filter(a => a.kind === "door_open").length, 1);
});
test("LED·부저 요청은 독립이며 전달 승인을 실행·실제 출력으로 표시하지 않는다", async () => {
  const id = crypto.randomUUID();
  const led = await output("led", "on", id); assert.equal(led.status, 200);
  assert.equal((await output("led", "on", id)).status, 200);
  assert.equal((await output("led", "test", id)).status, 409);
  assert.equal((await output("led", "on")).status, 409);
  assert.equal((await output("buzzer", "test")).status, 200);
  let s = await snapshot(), row = s.outputCommands.find(c => c.id === id);
  assert.equal(row.status, "pending"); assert.equal(row.applied_at, null);
  assert.equal((await ack(id)).status, 409);
  assert.equal((await claim(id, "f".repeat(32))).status, 409);
  assert.equal((await claim(id)).status, 200);
  assert.equal((await (await claim(id)).json()).alreadyClaimed, true);
  s = await snapshot(); row = s.outputCommands.find(c => c.id === id);
  assert.equal(row.status, "claimed"); assert.equal(row.applied_at, null); assert.equal(s.sensor.board.ledOn, false);
  assert.equal((await ack(id)).status, 200); assert.equal((await (await ack(id)).json()).alreadyApplied, true);
  assert.equal((await snapshot()).sensor.board.ledOn, false);
  await send({ board: { ledOn: true, ledSource: "manual" } });
  assert.equal((await snapshot()).sensor.board.ledOn, true);
});
test("끄기는 대기 중 요청을 대체하지만 이미 전달된 동작 중지는 단정하지 않는다", async () => {
  const previous = (await snapshot()).outputCommands.find(c => c.target === "buzzer");
  await claim(previous.id);
  const response = await output("buzzer", "off"); assert.equal(response.status, 200);
  const s = await response.json(), off = s.outputCommands.find(c => c.target === "buzzer");
  assert.equal(off.seconds, 30); assert.equal(off.status, "pending");
  assert.equal(s.outputCommands.find(c => c.id === previous.id).status, "cancelled");
  assert.equal((await ack(previous.id)).status, 409);
  await claim(off.id); await ack(off.id);
  const mute = await (await output("alarm", "mute")).json(), cmd = mute.outputCommands.find(c => c.target === "alarm");
  assert.equal(cmd.seconds, 60); await claim(cmd.id); await ack(cmd.id);
  assert.equal((await snapshot()).sensor.board.muteSeconds, 0); // Needs a fresh report, not an inferred mute.
});
test("응답이 없거나 기한이 지난 제어는 성공 처리·늦은 실행을 하지 않는다", async () => {
  const p = await (await output("led", "test")).json(), id = p.outputCommands.find(c => c.target === "led").id;
  await home.db.prepare("UPDATE home_output_commands SET expires_at = ? WHERE id = ?").bind(new Date(Date.now()-1000).toISOString(), id).run();
  assert.equal((await claim(id)).status, 409); assert.equal((await snapshot()).outputCommands.find(c => c.id === id).status, "expired");
  const next = await (await output("led", "test")).json(), nextId = next.outputCommands.find(c => c.target === "led").id;
  await claim(nextId);
  await home.db.prepare("UPDATE home_output_commands SET claimed_at = ? WHERE id = ?").bind(new Date(Date.now()-31000).toISOString(), nextId).run();
  assert.equal((await ack(nextId)).status, 409);
});
test("같은 출력 요청을 동시에 가져가도 새 전달 승인은 하나뿐이다", async () => {
  const s = await (await output("led", "test")).json(), id = s.outputCommands.find(c => c.target === "led").id;
  const responses = await Promise.all([claim(id), claim(id)]);
  const grants = await Promise.all(responses.map(r => r.json()));
  assert.equal(grants.filter(g => g.ok && g.alreadyClaimed === false).length, 1);
  await ack(id);
});
test("같은 측정 재전송은 수신 시각을 연장하지 않고 지난 순서를 거부한다", async () => {
  const { p } = await send();
  await home.db.prepare("UPDATE home_state SET value = json_set(value, '$.lastSeen', ?) WHERE scope = 'family'").bind(new Date(Date.now()-16000).toISOString()).run();
  assert.equal((await device("/telemetry", p)).status, 200);
  assert.equal((await snapshot()).online, false);
  assert.equal((await device("/telemetry", packet(seq-1))).status, 409);
  await send();
});
test("새 USB 연결은 이전 연결을 종료하고 가스 감시를 임의로 다시 켜지 않는다", async () => {
  const old = sid, oldSeq = seq;
  await output("buzzer", "on");
  sid = "b".repeat(32); seq = 0;
  const { response } = await send(); assert.equal(response.config.gasEnabled, false);
  const s = await snapshot(); assert.equal(s.settings.gasEnabled, true); assert.equal(s.boardConfig.gasEnabled, false);
  assert.equal(s.outputCommands.find(c => c.target === "buzzer").status, "cancelled");
  const late = packet(oldSeq + 1); late.board.session = old; late.sampleId = `${old}:${oldSeq+1}`;
  assert.equal((await device("/telemetry", late)).status, 409);
  assert.equal((await snapshot()).sensor.board.session, sid);
});
test("V3 동작 중 구형 제어·측정이 상태를 덮지 않고 이전 기록은 조회된다", async () => {
  assert.equal((await device("/telemetry", { sampleId: "old:1", gasSensor: "MQ-135", gasAdc: 100, gasVoltageV: 0.49, dustUgM3: null, distanceCm: 12 })).status, 409);
  assert.equal((await home.family("/commands", { method: "POST", body: JSON.stringify({ action: "start", id: crypto.randomUUID() }) })).status, 409);
  const date = new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const records = await home.family(`/events?date=${date}&type=gas`);
  assert.equal(records.status, 200); assert.equal((await records.json()).total, 2);
});
test("연결 키 교체 뒤 과거 USB 세션을 되살리지 않고 기록을 보존한다", async () => {
  const count = (await home.db.prepare("SELECT COUNT(*) AS n FROM home_events").first()).n;
  const previous = token;
  token = (await (await home.family("/device", { method: "POST", body: "{}" })).json()).token;
  assert.notEqual(token, previous); assert.equal((await snapshot()).online, false);
  assert.equal((await device("/telemetry", packet(seq+1))).status, 409);
  sid="c".repeat(32); seq=0; await send();
  assert.equal((await home.db.prepare("SELECT COUNT(*) AS n FROM home_events").first()).n, count);
});
