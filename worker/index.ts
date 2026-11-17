import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { analyzeSample, automationProtocol, defaultSettings, emptySensor, eventTitles, isQuietTime, kstDay, normalizeHomeSettings, validateHomeSettings } from "../src/lib/home-model";
import type { EventKind, HomeAlert, HomeEvent, HomeSettings, OutputAction, OutputCommand, OutputTarget, SensorState, SirenCommand } from "../src/lib/home-model";
import { bearerToken, describeError, rateLimited, rateLimitReached, sha256, type Bindings } from "./lib";
import { configuredBoard, outputDetail, parseAutomationPacket } from "./automation";

type AppEnv = { Bindings: Bindings; Variables: { scope: string; deviceHash: string } };
type AppContext = Context<AppEnv>;
type StateRow = { value: string; version: number; last_packet: string };
const app = new Hono<AppEnv>().basePath("/api");

app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "보낼 내용이 너무 커요." }, 413) }));
app.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("x-robots-tag", "noindex");
});
app.get("/health", c => c.json({ ok: true }));

async function verifyFamily(c: AppContext) {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(bearerToken(c.req.header("authorization")))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

app.get("/home/access", c => c.json({ configured: Boolean(c.env.ADMIN_TOKEN) }));
async function familyAccessError(c: AppContext) {
  if (!c.env.ADMIN_TOKEN) return c.json({ error: "아직 가족 비밀번호를 설정하지 않았어요. 먼저 소유자가 가족 비밀번호를 설정해 주세요." }, 403);
  if (await rateLimitReached(c, "family-access", 15, 600)) return c.json({ error: "시도가 너무 많아요. 10분 뒤 다시 열어 주세요." }, 429);
  if (!await verifyFamily(c)) {
    await rateLimited(c, "family-access", 15, 600);
    return c.json({ error: "가족 비밀번호가 맞지 않아요. 다시 입력해 주세요." }, 401);
  }
  return null;
}
app.post("/home/unlock", async c => {
  const error = await familyAccessError(c);
  if (error) return error;
  return c.json({ ok: true });
});

const familyScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const error = await familyAccessError(c);
  if (error) return error;
  c.set("scope", "family");
  await next();
};
app.use("/home/*", familyScope);

async function readSettings(db: D1Database, scope: string): Promise<HomeSettings> {
  const row = await db.prepare("SELECT value FROM home_settings WHERE scope = ?").bind(scope).first<{ value: string }>();
  return normalizeHomeSettings(row ? JSON.parse(row.value) : undefined);
}
async function readSensor(db: D1Database, scope: string): Promise<StateRow | null> {
  return db.prepare("SELECT value, version, last_packet FROM home_state WHERE scope = ?").bind(scope).first<StateRow>();
}
function sensorValue(row: StateRow | null): SensorState {
  const value = row ? JSON.parse(row.value) as SensorState : emptySensor;
  const keys = Object.keys(emptySensor) as (keyof SensorState)[];
  return Object.fromEntries(keys.map(key => [key, value[key] ?? emptySensor[key]])) as SensorState;
}
async function initHome(c: AppContext) {
  const scope = c.get("scope"), db = c.env.DB;
  if (await readSensor(db, scope)) return;
  const time = new Date().toISOString();
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO home_settings (scope, value, updated_at) VALUES (?, ?, ?)").bind(scope, JSON.stringify(defaultSettings), time),
    db.prepare("INSERT OR IGNORE INTO home_state (scope, value) VALUES (?, ?)").bind(scope, JSON.stringify(emptySensor)),
  ];
  await db.batch(stmts);
}

function eventStatements(db: D1Database, scope: string, settings: HomeSettings, kind: EventKind, now: string, id = crypto.randomUUID(), detail = "", packet?: string) {
  const emergency = kind === "door_open" && isQuietTime(settings, Date.parse(now)) || kind === "fire_risk" && settings.fireAlerts || kind === "gas_alert" && settings.gasAlerts;
  const suffix = packet ? " WHERE EXISTS (SELECT 1 FROM home_state WHERE scope = ? AND last_packet = ?)" : "";
  const event = db.prepare(`INSERT OR IGNORE INTO home_events (id, scope, kind, title, detail, emergency, created_at) SELECT ?, ?, ?, ?, ?, ?, ?${suffix}`);
  const params: (string | number)[] = [id, scope, kind, eventTitles[kind], detail, emergency ? 1 : 0, now];
  if (packet) params.push(scope, packet);
  const stmts = [event.bind(...params)];
  const notify = (kind === "fire_risk" && settings.fireAlerts) || (kind === "gas_alert" && settings.gasAlerts) || (kind === "door_open" && emergency);
  if (notify) {
    const message = kind === "gas_alert" ? "MQ-135 원시 출력이 직접 정한 실습 기준 이상으로 이어졌어요. 가스 종류·농도나 화재 판정은 아니에요. 집의 상황과 독립 경보기를 확인해 주세요." : kind === "fire_risk" ? "먼지 측정값이 설정 기준 이상으로 이어졌어요. 가족에게 연락해 집의 상황을 확인해 주세요." : "설정한 안심 시간(한국 시간)에 현관문 열림이 감지됐어요. 가족에게 연락해 상황을 확인해 주세요.";
    const alertParams: (string | number)[] = [id, scope, kind, eventTitles[kind], message, now];
    if (packet) alertParams.push(scope, packet);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO home_alerts (id, scope, kind, title, message, created_at) SELECT ?, ?, ?, ?, ?, ?${suffix}`).bind(...alertParams));
  }
  return stmts;
}

async function settleCommands(db: D1Database, scope: string) {
  const now = new Date().toISOString();
  await db.prepare("UPDATE home_commands SET status = 'expired' WHERE scope = ? AND status = 'pending' AND expires_at < ?").bind(scope, now).run();
  // No device response must never be presented as a successful stop.
  await db.prepare("UPDATE home_commands SET status = 'expired' WHERE scope = ? AND status = 'acknowledged' AND julianday(started_at) + (seconds + 30) / 86400.0 < julianday(?)").bind(scope, now).run();
  await db.prepare("UPDATE home_output_commands SET status = 'expired' WHERE scope = ? AND ((status = 'pending' AND expires_at < ?) OR (status = 'claimed' AND julianday(claimed_at) + 30 / 86400.0 < julianday(?)))").bind(scope, now, now).run();
}
async function snapshot(c: AppContext) {
  await initHome(c);
  const scope = c.get("scope"), db = c.env.DB;
  await settleCommands(db, scope);
  const todayStart = new Date(`${kstDay()}T00:00:00+09:00`).toISOString();
  const [settings, state, events, alerts, count, command, device, outputs] = await Promise.all([
    readSettings(db, scope), readSensor(db, scope),
    db.prepare("SELECT id, kind, title, detail, emergency, created_at FROM home_events WHERE scope = ? AND kind IN ('door_open', 'door_closed') AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 6").bind(scope, todayStart).all<HomeEvent>(),
    db.prepare("SELECT id, title, message, kind, created_at, read_at FROM home_alerts WHERE scope = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").bind(scope).all<HomeAlert>(),
    db.prepare("SELECT COUNT(*) AS count FROM home_events WHERE scope = ? AND kind = 'door_open' AND created_at >= ?").bind(scope, todayStart).first<{ count: number }>(),
    db.prepare("SELECT id, action, seconds, status, created_at, expires_at, started_at, completed_at FROM home_commands WHERE scope = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(scope).first<SirenCommand>(),
    db.prepare("SELECT name FROM home_devices WHERE scope = ?").bind(scope).first<{ name: string }>(),
    db.prepare("SELECT * FROM home_output_commands WHERE scope = ? ORDER BY created_at DESC, rowid DESC LIMIT 12").bind(scope).all<OutputCommand>(),
  ]);
  const sensor = sensorValue(state);
  const online = Boolean(sensor.lastSeen && Date.now() - Date.parse(sensor.lastSeen) <= 15_000);
  return { settings, sensor, online, events: events.results, alerts: alerts.results, todayOpenCount: count?.count ?? 0, command, outputCommands: outputs.results, boardConfig: await configuredBoard(settings, sensor.board?.session ?? null), device: { paired: Boolean(device), name: device?.name ?? "우리 집 안심 센서" }, serverTime: new Date().toISOString() };
}
app.get("/home/snapshot", async c => c.json(await snapshot(c)));

app.put("/home/settings", async c => {
  const checked = validateHomeSettings(await c.req.json().catch(() => null));
  if (!checked.value) return c.json({ error: checked.error }, 400);
  await initHome(c);
  const scope = c.get("scope"), db = c.env.DB;
  const previous = await readSettings(db, scope), current = checked.value;
  const sensor = sensorValue(await readSensor(db, scope));
  if (current.gasEnabled && (!previous.gasEnabled || previous.gasArmSession !== current.gasArmSession)) {
    if (!sensor.board || current.gasArmSession !== sensor.board.session || !sensor.lastSeen || Date.now() - Date.parse(sensor.lastSeen) > 15_000 || sensor.gasAdc === null || sensor.gasAdc === 0 || sensor.gasAdc === 1023) return c.json({ error: "이번 USB 연결의 새 측정값과 예열·기준값을 확인한 뒤 감시를 시작해 주세요." }, 409);
  }
  const stmts = [db.prepare("INSERT INTO home_settings (scope, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(scope, JSON.stringify(current), new Date().toISOString())];
  if (previous.dustThreshold !== current.dustThreshold || previous.sustainedSeconds !== current.sustainedSeconds || previous.closedDistance !== current.closedDistance || previous.doorTolerance !== current.doorTolerance) {
    // Reset consecutive-reading windows atomically without overwriting a concurrent measurement.
    stmts.push(db.prepare("UPDATE home_state SET value = json_set(value, '$.aboveSince', NULL, '$.belowSince', NULL, '$.candidateSince', NULL), version = version + 1 WHERE scope = ?").bind(scope));
  }
  if (JSON.stringify(await configuredBoard(previous, sensor.board?.session ?? null)) !== JSON.stringify(await configuredBoard(current, sensor.board?.session ?? null))) stmts.push(...eventStatements(db, scope, current, "sensor_settings", new Date().toISOString(), crypto.randomUUID(), "앱에 저장했어요. 홈의 설정 적용 표시에서 보드의 새 수신 응답을 확인해 주세요. 가스 농도·화재 감도 설정이 아니에요."));
  await db.batch(stmts);
  return c.json(await snapshot(c));
});

app.get("/home/events", async c => {
  await initHome(c);
  const date = c.req.query("date") ?? kstDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00+09:00`)) || kstDay(`${date}T00:00:00+09:00`) !== date) return c.json({ error: "조회할 날짜를 다시 선택해 주세요." }, 400);
  const type = c.req.query("type") ?? "all";
  const types: Record<string, EventKind[]> = { door: ["door_open", "door_closed"], gas: ["gas_alert", "gas_below"], fire: ["fire_risk", "fire_clear"], siren: ["siren_requested", "siren_started", "siren_stopped"], control: ["output_requested", "output_applied", "output_rejected", "sensor_settings", "siren_requested", "siren_started", "siren_stopped"] };
  if (type !== "all" && !types[type]) return c.json({ error: "기록 종류를 다시 선택해 주세요." }, 400);
  const start = new Date(`${date}T00:00:00+09:00`).toISOString(), end = new Date(Date.parse(start) + 86400_000).toISOString();
  const offset = Math.min(5000, Math.max(0, Math.floor(Number(c.req.query("offset")) || 0)));
  const args: (string | number)[] = [c.get("scope"), start, end];
  let where = "scope = ? AND created_at >= ? AND created_at < ?";
  if (types[type]) { where += ` AND kind IN (${types[type].map(() => "?").join(",")})`; args.push(...types[type]); }
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`SELECT id, kind, title, detail, emergency, created_at FROM home_events WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT 50 OFFSET ?`).bind(...args, offset).all<HomeEvent>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM home_events WHERE ${where}`).bind(...args).first<{ count: number }>(),
  ]);
  return c.json({ rows: rows.results, total: total?.count ?? 0 });
});

app.patch("/home/alerts/read", async c => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
  if (!Array.isArray(body.ids) || body.ids.length > 100 || body.ids.some(id => typeof id !== "string" || id.length > 150)) return c.json({ error: "읽을 알림을 다시 선택해 주세요." }, 400);
  if (body.ids.length) await c.env.DB.prepare(`UPDATE home_alerts SET read_at = ? WHERE scope = ? AND id IN (${body.ids.map(() => "?").join(",")}) AND read_at IS NULL`).bind(new Date().toISOString(), c.get("scope"), ...body.ids).run();
  return c.json({ ok: true });
});

app.post("/home/commands", async c => {
  if (await rateLimited(c, "siren-control", 40, 60)) return c.json({ error: "요청이 너무 많아요. 잠시 뒤 다시 눌러 주세요." }, 429);
  const body = await c.req.json<{ action?: string; id?: string }>().catch(() => ({} as { action?: string; id?: string }));
  if ((body.action !== "start" && body.action !== "stop") || !body.id || !/^[a-f0-9-]{36}$/.test(body.id)) return c.json({ error: "사이렌 요청을 다시 보내 주세요." }, 400);
  const current = await snapshot(c), scope = c.get("scope"), db = c.env.DB;
  if (current.sensor.board) return c.json({ error: "새 USB 코드에서는 LED·부저 독립 제어를 사용해 주세요." }, 409);
  const existing = await db.prepare("SELECT id FROM home_commands WHERE scope = ? AND id = ?").bind(scope, body.id).first();
  if (existing) return c.json(await snapshot(c));
  if (body.action === "start" && !current.online) return c.json({ error: "기기가 연결되어 있지 않아 사이렌을 보낼 수 없어요." }, 409);
  if (body.action === "start" && current.command && ["pending", "acknowledged"].includes(current.command.status)) return c.json({ error: "이미 사이렌 요청을 처리하고 있어요." }, 409);
  const now = new Date().toISOString(), seconds = body.action === "start" ? current.settings.sirenSeconds : 0;
  const stmts: D1PreparedStatement[] = [];
  if (body.action === "stop") {
    stmts.push(db.prepare("UPDATE home_commands SET status = 'cancelled', completed_at = ? WHERE scope = ? AND status = 'pending'").bind(now, scope));
  }
  stmts.push(db.prepare("INSERT INTO home_commands (id, scope, action, seconds, status, created_at, expires_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(body.id, scope, body.action, seconds, "pending", now, new Date(Date.now() + (body.action === "start" ? 15_000 : 60_000)).toISOString(), null, null));
  stmts.push(...eventStatements(db, scope, current.settings, "siren_requested", now, `${body.id}:requested`, body.action === "start" ? "기기의 실행 응답을 기다리고 있어요." : "기기에 중지를 요청했어요. 중지 응답을 기다려 주세요."));
  try { await db.batch(stmts); }
  catch (err) {
    const active = await db.prepare("SELECT id FROM home_commands WHERE scope = ? AND status IN ('pending', 'acknowledged')").bind(scope).first();
    if (active) return c.json({ error: "이미 처리 중인 요청이 있어요. 잠시 뒤 상태를 확인해 주세요." }, 409);
    throw err;
  }
  return c.json(await snapshot(c));
});

app.post("/home/device", async c => {
  await initHome(c);
  if (await rateLimited(c, "device-key", 10, 600)) return c.json({ error: "연결 키를 너무 자주 바꿨어요. 잠시 뒤 다시 시도해 주세요." }, 429);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  // Rotation also cancels queued actions and invalidates the last device heartbeat.
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO home_devices (scope, name, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at").bind(c.get("scope"), "우리 집 안심 센서", await sha256(token), now),
    c.env.DB.prepare("UPDATE home_state SET value = ?, version = version + 1, last_packet = '' WHERE scope = ?").bind(JSON.stringify(emptySensor), c.get("scope")),
    c.env.DB.prepare("UPDATE home_commands SET status = 'cancelled', completed_at = ? WHERE scope = ? AND status IN ('pending', 'acknowledged')").bind(now, c.get("scope")),
    c.env.DB.prepare("UPDATE home_output_commands SET status = 'cancelled' WHERE scope = ? AND status IN ('pending', 'claimed')").bind(c.get("scope")),
    c.env.DB.prepare("UPDATE home_device_sessions SET retired = 1 WHERE scope = ?").bind(c.get("scope")),
  ]);
  return c.json({ token });
});

const deviceOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  if (!/^[a-f0-9]{64}$/.test(token)) return c.json({ error: "기기 연결 키를 확인해 주세요." }, 401);
  const row = await c.env.DB.prepare("SELECT scope FROM home_devices WHERE token_hash = ?").bind(await sha256(token)).first<{ scope: string }>();
  if (!row || row.scope !== "family") return c.json({ error: "기기 연결 키를 확인해 주세요." }, 401);
  c.set("scope", row.scope); c.set("deviceHash", await sha256(token));
  await next();
};
app.use("/device/*", deviceOnly);

async function pendingCommand(db: D1Database, scope: string) {
  await settleCommands(db, scope);
  return db.prepare("SELECT id, action, seconds, expires_at FROM home_commands WHERE scope = ? AND status = 'pending' AND expires_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(scope, new Date().toISOString()).first<Pick<SirenCommand, "id" | "action" | "seconds" | "expires_at">>();
}

async function automationResponse(c: AppContext, settings: HomeSettings, session: string) {
  const db = c.env.DB, scope = c.get("scope");
  await settleCommands(db, scope);
  const commands = await db.prepare("SELECT id, target, action, seconds, expires_at, session FROM home_output_commands WHERE scope = ? AND session = ? AND status = 'pending' AND expires_at >= ? ORDER BY created_at, rowid LIMIT 3").bind(scope, session, new Date().toISOString()).all<OutputCommand>();
  return c.json({ ok: true, protocol: automationProtocol, serverTime: new Date().toISOString(), intervalMs: 2000, config: await configuredBoard(settings, session), commands: commands.results });
}

async function receiveAutomation(c: AppContext, body: unknown) {
  const packet = parseAutomationPacket(body);
  if (!packet) return c.json({ error: "자동 감지 측정·출력 응답 형식을 확인해 주세요. 실패값을 정상으로 보내면 안 돼요." }, 400);
  const db = c.env.DB, scope = c.get("scope"), settings = await readSettings(db, scope);
  const sessionRow = await db.prepare("SELECT retired FROM home_device_sessions WHERE scope = ? AND session = ?").bind(scope, packet.board.session).first<{ retired: number }>();
  if (sessionRow?.retired) return c.json({ error: "이미 끝난 USB 연결이에요. 이전 측정을 재전송하지 마세요." }, 409);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readSensor(db, scope);
    if (!row) return c.json({ error: "가족 공간을 먼저 열어 주세요." }, 409);
    const previous = sensorValue(row);
    if (row.last_packet === packet.sampleId) return automationResponse(c, settings, packet.board.session);
    if (previous.board?.session === packet.board.session && previous.board.sequence >= packet.board.sequence) return c.json({ error: "지난 순서의 측정이에요. 새 측정만 보내 주세요." }, 409);
    // V3's local classification is authoritative. Never run the legacy cloud
    // classifier over it, or two different persistence clocks would disagree.
    const now = new Date().toISOString();
    const next: SensorState = { ...previous, gasSensor: "MQ-135", gasAdc: packet.gasAdc, gasVoltageV: packet.gasVoltageV,
      dust: null, dustSensor: null, dustVoltageV: null, distance: packet.distanceCm, doorStatus: packet.board.doorStatus,
      fireStatus: previous.fireStatus === "risk" ? "risk" : "unknown", board: packet.board, lastSeen: now,
      aboveSince: null, belowSince: null, candidateSince: null, doorCandidate: "unknown" };
    const guard = "EXISTS (SELECT 1 FROM home_state WHERE scope = ? AND last_packet = ?)";
    const stmts = [db.prepare("UPDATE home_state SET value = ?, version = version + 1, last_packet = ? WHERE scope = ? AND version = ? AND EXISTS (SELECT 1 FROM home_devices WHERE scope = ? AND token_hash = ?) AND NOT EXISTS (SELECT 1 FROM home_device_sessions WHERE scope = ? AND session = ? AND retired = 1)").bind(JSON.stringify(next), packet.sampleId, scope, row.version, scope, c.get("deviceHash"), scope, packet.board.session)];
    if (previous.board?.session !== packet.board.session) {
      stmts.push(db.prepare(`UPDATE home_device_sessions SET retired = 1 WHERE scope = ? AND session != ? AND ${guard}`).bind(scope, packet.board.session, scope, packet.sampleId));
      stmts.push(db.prepare(`INSERT OR IGNORE INTO home_device_sessions (scope, session) SELECT ?, ? WHERE ${guard}`).bind(scope, packet.board.session, scope, packet.sampleId));
      stmts.push(db.prepare(`UPDATE home_output_commands SET status = 'cancelled' WHERE scope = ? AND session != ? AND status IN ('pending', 'claimed') AND ${guard}`).bind(scope, packet.board.session, scope, packet.sampleId));
    }
    for (const event of packet.boardEvents) {
      const detail = event.kind.startsWith("gas") ? `MQ-135 ADC ${event.gasAdc} · 실습용 출력 변화 기록. 농도·안전·화재 판정이 아니에요.` : `초음파 ${event.distanceCm} cm · 보드의 지속 감지 응답`;
      stmts.push(...eventStatements(db, scope, settings, event.kind, now, `board:${packet.board.session}:${event.sequence}`, `${detail} · 시간은 앱 수신 기준`, packet.sampleId));
    }
    const result = await db.batch(stmts);
    if (result[0].meta.changes) return automationResponse(c, settings, packet.board.session);
  }
  return c.json({ error: "측정이 겹쳤거나 연결이 바뀌었어요. 최신 연결을 확인해 주세요." }, 409);
}

app.post("/home/outputs", async c => {
  if (await rateLimited(c, "output-control", 60, 60)) return c.json({ error: "요청이 너무 많아요. 잠시 뒤 다시 눌러 주세요." }, 429);
  const body = await c.req.json<{ id?: string; target?: OutputTarget; action?: OutputAction }>().catch(() => null);
  if (!body || typeof body.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.id) || !["led", "buzzer", "alarm"].includes(body.target ?? "") || !(body.target === "alarm" ? ["mute", "resume"] : ["on", "off", "test"]).includes(body.action ?? "")) return c.json({ error: "LED·부저 제어 내용을 확인해 주세요." }, 400);
  const target = body.target!, action = body.action!, scope = c.get("scope"), db = c.env.DB;
  const current = await snapshot(c), session = current.sensor.board?.session;
  const existing = await db.prepare("SELECT target, action FROM home_output_commands WHERE id = ? AND scope = ?").bind(body.id, scope).first<OutputCommand>();
  if (existing) return existing.target === target && existing.action === action ? c.json(await snapshot(c)) : c.json({ error: "이미 다른 동작에 사용한 요청 번호예요." }, 409);
  if (!session || !current.device.paired || (["on", "test", "resume"].includes(action) && !current.online)) return c.json({ error: "새 USB 코드의 최신 측정값이 도착해야 출력을 켜거나 자동 경고음을 재개할 수 있어요." }, 409);
  const seconds = action === "test" ? 2 : action === "on" ? current.settings.sirenSeconds : action === "off" ? 30 : action === "mute" ? 60 : 0;
  const now = new Date().toISOString(), stmts: D1PreparedStatement[] = [];
  if (["off", "mute", "resume"].includes(action)) stmts.push(db.prepare("UPDATE home_output_commands SET status = 'cancelled' WHERE scope = ? AND target = ? AND status IN ('pending', 'claimed')").bind(scope, target));
  stmts.push(db.prepare("INSERT INTO home_output_commands (id, scope, target, action, seconds, status, session, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)").bind(body.id, scope, target, action, seconds, session, now, new Date(Date.now() + 15_000).toISOString()));
  stmts.push(...eventStatements(db, scope, current.settings, "output_requested", now, `${body.id}:requested`, `${outputDetail(target, action, seconds)} · 아직 보드 실행 응답이 없어요.`));
  try { await db.batch(stmts); }
  catch (error) {
    const active = await db.prepare("SELECT id FROM home_output_commands WHERE scope = ? AND target = ? AND status IN ('pending', 'claimed')").bind(scope, target).first();
    if (active) return c.json({ error: "해당 출력의 앞선 요청이 처리 중이에요. 끄기는 계속 요청할 수 있어요." }, 409);
    throw error;
  }
  return c.json(await snapshot(c));
});

app.post("/device/outputs/:id/claim", async c => {
  const body = await c.req.json<{ session?: string }>().catch(() => null), db = c.env.DB, scope = c.get("scope");
  const sensor = sensorValue(await readSensor(db, scope)), session = body?.session;
  if (!session || session !== sensor.board?.session || !sensor.lastSeen || Date.now() - Date.parse(sensor.lastSeen) > 15_000) return c.json({ error: "현재 USB 연결의 새 측정값을 먼저 보내 주세요." }, 409);
  await settleCommands(db, scope);
  const row = await db.prepare("SELECT * FROM home_output_commands WHERE id = ? AND scope = ? AND session = ?").bind(c.req.param("id"), scope, session).first<OutputCommand>();
  if (!row) return c.json({ error: "이번 연결의 요청이 아니에요." }, 404);
  if (row.status === "claimed" || row.status === "applied") return c.json({ ok: true, alreadyClaimed: true });
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE home_output_commands SET status = 'claimed', claimed_at = ? WHERE id = ? AND scope = ? AND session = ? AND status = 'pending' AND expires_at >= ? AND EXISTS (SELECT 1 FROM home_devices WHERE scope = ? AND token_hash = ?) AND EXISTS (SELECT 1 FROM home_state WHERE scope = ? AND json_extract(value, '$.board.session') = ?)").bind(now, row.id, scope, session, now, scope, c.get("deviceHash"), scope, session).run();
  if (!result.meta.changes) return c.json({ error: "취소되었거나 기한이 지났어요. 출력을 켜지 마세요." }, 409);
  return c.json({ ok: true, alreadyClaimed: false });
});

app.post("/device/outputs/:id/ack", async c => {
  const body = await c.req.json<{ session?: string; status?: string }>().catch(() => null);
  if (!body || !["applied", "rejected"].includes(body.status ?? "")) return c.json({ error: "보드의 실행 응답을 보내 주세요." }, 400);
  const db = c.env.DB, scope = c.get("scope");
  await settleCommands(db, scope);
  const row = await db.prepare("SELECT * FROM home_output_commands WHERE id = ? AND scope = ? AND session = ?").bind(c.req.param("id"), scope, body.session ?? "").first<OutputCommand>();
  if (!row) return c.json({ error: "이번 연결의 요청이 아니에요." }, 404);
  if (row.status === body.status) return c.json({ ok: true, alreadyApplied: true });
  if (row.status !== "claimed") return c.json({ error: "전달 승인 전이거나 이미 끝난 요청이에요." }, 409);
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE home_output_commands SET status = ?, applied_at = ? WHERE id = ? AND scope = ? AND status = 'claimed' AND EXISTS (SELECT 1 FROM home_devices WHERE scope = ? AND token_hash = ?) AND EXISTS (SELECT 1 FROM home_state WHERE scope = ? AND json_extract(value, '$.board.session') = ?)").bind(body.status, now, row.id, scope, scope, c.get("deviceHash"), scope, body.session!).run();
  if (!result.meta.changes) return c.json({ error: "연결이나 요청 상태가 바뀌었어요." }, 409);
  await db.batch(eventStatements(db, scope, await readSettings(db, scope), body.status === "applied" ? "output_applied" : "output_rejected", now, `${row.id}:${body.status}`, `${outputDetail(row.target, row.action, row.seconds)} · 실제 빛·소리는 현장에서 확인해 주세요. 현재 출력은 새 측정 응답을 따로 확인해요.`));
  return c.json({ ok: true });
});

app.post("/device/telemetry", async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body?.protocol === automationProtocol) return receiveAutomation(c, body);
  if (body && (body.protocol != null || body.board != null || body.boardEvents != null)) return c.json({ error: "새 USB 코드와 연결 프로그램을 함께 사용해 주세요." }, 400);
  if (!body || typeof body.sampleId !== "string" || !/^[a-zA-Z0-9:_-]{1,80}$/.test(body.sampleId)) return c.json({ error: "sampleId가 필요해요." }, 400);
  const validNumber = (n: unknown, min: number, max: number) => n === null || typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (!validNumber(body.dustUgM3, 0, 5000) || !validNumber(body.distanceCm, 2, 400)) return c.json({ error: "보정된 먼지 수치(0~5000)와 거리(2~400)를 보내 주세요. 측정 실패는 null로 보내 주세요." }, 400);
  const rawDust = body.dustSensor === "GP2Y1014AU0F";
  if (body.dustSensor != null && !rawDust || rawDust && (body.dustUgM3 !== null || !validNumber(body.dustVoltageV, 0, 5.5)) || !rawDust && body.dustVoltageV != null) return c.json({ error: "GP2Y1014AU0F는 원시 전압만 보내고 dustUgM3는 null로 보내 주세요. 화재 판정에 사용하지 않아요." }, 400);
  const gas = body.gasSensor === "MQ-135";
  if (body.gasSensor != null && !gas || gas && (body.dustUgM3 !== null || rawDust || !validNumber(body.gasVoltageV, 0, 5.5) || !validNumber(body.gasAdc, 0, 1023) || body.gasAdc !== null && !Number.isInteger(body.gasAdc) || (body.gasAdc === null) !== (body.gasVoltageV === null)) || !gas && (body.gasVoltageV != null || body.gasAdc != null)) return c.json({ error: "MQ-135의 ADC(0~1023)와 원시 전압을 함께 보내 주세요. 측정 실패는 둘 다 null이며 먼지 농도로 보내면 안 돼요." }, 400);
  const db = c.env.DB, scope = c.get("scope"), settings = await readSettings(db, scope);
  if (sensorValue(await readSensor(db, scope)).board) return c.json({ error: "새 자동 감지 연결 중에는 구형 측정 형식을 받지 않아요." }, 409);
  let stored = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readSensor(db, scope);
    if (!row) return c.json({ error: "가족 공간을 먼저 열어 주세요." }, 409);
    if (sensorValue(row).board) return c.json({ error: "새 자동 감지 연결 중에는 구형 측정 형식을 받지 않아요." }, 409);
    if (row.last_packet === body.sampleId) { stored = true; break; }
    const { next, changes } = analyzeSample(sensorValue(row), { dust: body.dustUgM3 as number | null, distance: body.distanceCm as number | null, dustSensor: rawDust ? "GP2Y1014AU0F" : null, dustVoltageV: rawDust ? body.dustVoltageV as number | null : null, gasSensor: gas ? "MQ-135" : null, gasVoltageV: gas ? body.gasVoltageV as number | null : null, gasAdc: gas ? body.gasAdc as number | null : null }, settings, Date.now());
    const stmts = [db.prepare("UPDATE home_state SET value = ?, version = version + 1, last_packet = ? WHERE scope = ? AND version = ? AND EXISTS (SELECT 1 FROM home_devices WHERE scope = ? AND token_hash = ?)").bind(JSON.stringify(next), body.sampleId, scope, row.version, scope, c.get("deviceHash"))];
    for (const kind of changes) stmts.push(...eventStatements(db, scope, settings, kind, next.lastSeen!, `packet:${body.sampleId}:${kind}`, kind.startsWith("fire") ? `보정된 먼지 수치 ${next.dust} µg/m³ · 기준 ${settings.dustThreshold} µg/m³` : `거리 센서 ${next.distance} cm`, body.sampleId));
    const result = await db.batch(stmts);
    if (result[0].meta.changes > 0) { stored = true; break; }
  }
  if (!stored) return c.json({ error: "측정값이 겹쳤어요. 같은 sampleId로 다시 보내 주세요." }, 409);
  return c.json({ ok: true, serverTime: new Date().toISOString(), intervalMs: 2000, maxSirenSeconds: 15, command: await pendingCommand(db, scope) });
});
app.get("/device/commands", async c => c.json({ serverTime: new Date().toISOString(), command: await pendingCommand(c.env.DB, c.get("scope")) }));
app.post("/device/commands/:id/ack", async c => {
  const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }));
  if (body.status !== "started" && body.status !== "completed") return c.json({ error: "실행 상태를 확인해 주세요." }, 400);
  const db = c.env.DB, scope = c.get("scope"), now = new Date().toISOString();
  const command = await db.prepare("SELECT * FROM home_commands WHERE id = ? AND scope = ?").bind(c.req.param("id"), scope).first<SirenCommand>();
  if (!command) return c.json({ error: "요청을 찾을 수 없어요." }, 404);
  if (command.status === "completed") return body.status === "completed" ? c.json({ ok: true, alreadyApplied: true }) : c.json({ error: "이미 끝난 요청이에요. 부저를 켜지 마세요." }, 409);
  if (["cancelled", "expired"].includes(command.status) || (command.status === "pending" && command.expires_at < now)) return c.json({ error: "기한이 지난 요청이에요. 부저를 켜지 마세요." }, 409);
  if (body.status === "started" && command.action !== "start") return c.json({ error: "중지 요청은 부저를 끈 후 completed로 응답해 주세요." }, 400);
  if (body.status === "started" && command.status === "acknowledged") return c.json({ ok: true, alreadyApplied: true });
  if (body.status === "completed" && command.action === "start" && command.status !== "acknowledged") return c.json({ error: "실행 응답을 먼저 보내 주세요." }, 409);
  const settings = await readSettings(db, scope);
  const stmts: D1PreparedStatement[] = [];
  if (body.status === "started") {
    const claimed = await db.prepare("UPDATE home_commands SET status = 'acknowledged', started_at = ? WHERE id = ? AND scope = ? AND status = 'pending' AND expires_at >= ?").bind(now, command.id, scope, now).run();
    if (!claimed.meta.changes) return c.json({ error: "이미 취소되었거나 기한이 지난 요청이에요. 부저를 켜지 마세요." }, 409);
  } else {
    stmts.push(db.prepare("UPDATE home_commands SET status = 'completed', completed_at = ? WHERE id = ?").bind(now, command.id));
    if (command.action === "stop") stmts.push(db.prepare("UPDATE home_commands SET status = 'completed', completed_at = ? WHERE scope = ? AND action = 'start' AND status = 'acknowledged' AND created_at <= ?").bind(now, scope, command.created_at));
  }
  stmts.push(...eventStatements(db, scope, settings, body.status === "started" ? "siren_started" : "siren_stopped", now, `${command.id}:${body.status}`, "기기에서 실행 상태 응답을 받았어요. 실제 소리 여부는 현장에서 확인해 주세요."));
  await db.batch(stmts);
  return c.json({ ok: true });
});

app.notFound(c => c.json({ error: "요청한 기능을 찾을 수 없어요." }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(`[api] ${c.req.method} ${c.req.path}\n${describeError(err)}`);
  return c.json({ error: "지금은 집의 정보를 불러올 수 없어요. 잠시 뒤 다시 시도해 주세요." }, 500);
});
export default app;
