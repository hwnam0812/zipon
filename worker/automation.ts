import { automationProtocol, hardwareConfig, type BoardConfig, type BoardEvent, type BoardReport, type HomeSettings, type OutputAction, type OutputTarget } from "../src/lib/home-model";
import { sha256 } from "./lib";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const nullableNumber = (v: unknown, min: number, max: number) => v === null || typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export type AutomationPacket = { sampleId: string; gasAdc: number | null; gasVoltageV: number | null; distanceCm: number | null; board: BoardReport; boardEvents: BoardEvent[] };

/** Validate the complete wire format before trusting a paired board's classifications. */
export function parseAutomationPacket(input: unknown): AutomationPacket | null {
  if (!object(input) || input.protocol !== automationProtocol || input.gasSensor !== "MQ-135" || input.dustUgM3 !== null || input.dustSensor != null || input.dustVoltageV != null) return null;
  if (!nullableNumber(input.gasAdc, 0, 1023) || input.gasAdc !== null && !Number.isInteger(input.gasAdc) || !nullableNumber(input.gasVoltageV, 0, 5.5) || (input.gasAdc === null) !== (input.gasVoltageV === null) || !nullableNumber(input.distanceCm, 2, 400)) return null;
  const b = input.board;
  if (!object(b) || typeof b.session !== "string" || !/^[a-f0-9]{32}$/.test(b.session) || !integer(b.sequence, 1, 4294967295) || input.sampleId !== `${b.session}:${b.sequence}` || !integer(b.uptimeMs, 0, 4294967295) || typeof b.configRevision !== "string" || !/^[a-f0-9]{16}$/.test(b.configRevision)) return null;
  if (!["open", "closed", "unknown"].includes(String(b.doorStatus)) || !["disabled", "below", "watch", "alert", "fault"].includes(String(b.gasStatus))) return null;
  if (["gasAlarm", "ledOn", "buzzerOn"].some(key => typeof b[key] !== "boolean")) return null;
  for (const key of ["ledSource", "buzzerSource"]) if (!["off", "manual", "door", "gas", "paused"].includes(String(b[key]))) return null;
  if (!integer(b.muteSeconds, 0, 60) || !integer(b.ledOffSeconds, 0, 30) || !integer(b.buzzerOffSeconds, 0, 30)) return null;
  if (input.distanceCm === null && b.doorStatus !== "unknown") return null;
  if ((input.gasAdc === null || input.gasAdc === 0) && !["disabled", "fault"].includes(String(b.gasStatus))) return null;
  if (b.gasStatus === "alert" && !b.gasAlarm || ["below", "watch"].includes(String(b.gasStatus)) && b.gasAlarm) return null;
  if (["off", "paused"].includes(String(b.ledSource)) && b.ledOn || ["off", "paused"].includes(String(b.buzzerSource)) && b.buzzerOn) return null;
  if (!Array.isArray(input.boardEvents) || input.boardEvents.length > 24) return null;
  const boardEvents: BoardEvent[] = [], ids = new Set<number>();
  for (const e of input.boardEvents) {
    if (!object(e) || !integer(e.sequence, 1, 4294967295) || ids.has(e.sequence) || !integer(e.uptimeMs, 0, 4294967295) || ((b.uptimeMs - e.uptimeMs) >>> 0) > 30_000 || !nullableNumber(e.gasAdc, 0, 1023) || e.gasAdc !== null && !Number.isInteger(e.gasAdc) || !nullableNumber(e.distanceCm, 2, 400)) return null;
    if (!["door_open", "door_closed", "gas_alert", "gas_below"].includes(String(e.kind))) return null;
    if (String(e.kind).startsWith("door") && e.distanceCm === null || String(e.kind).startsWith("gas") && (e.gasAdc === null || e.gasAdc === 0)) return null;
    ids.add(e.sequence);
    boardEvents.push({ sequence: e.sequence, kind: e.kind as BoardEvent["kind"], uptimeMs: e.uptimeMs, gasAdc: e.gasAdc as number | null, distanceCm: e.distanceCm as number | null });
  }
  return { sampleId: input.sampleId as string, gasAdc: input.gasAdc as number | null, gasVoltageV: input.gasVoltageV as number | null, distanceCm: input.distanceCm as number | null,
    board: { session: b.session, sequence: b.sequence, uptimeMs: b.uptimeMs, configRevision: b.configRevision, doorStatus: b.doorStatus as BoardReport["doorStatus"], gasStatus: b.gasStatus as BoardReport["gasStatus"], gasAlarm: b.gasAlarm as boolean,
      ledOn: b.ledOn as boolean, buzzerOn: b.buzzerOn as boolean, ledSource: b.ledSource as BoardReport["ledSource"], buzzerSource: b.buzzerSource as BoardReport["buzzerSource"], muteSeconds: b.muteSeconds, ledOffSeconds: b.ledOffSeconds, buzzerOffSeconds: b.buzzerOffSeconds }, boardEvents };
}

export async function configuredBoard(settings: HomeSettings, session: string | null): Promise<BoardConfig> {
  const config = hardwareConfig(settings, session);
  return { revision: (await sha256(JSON.stringify(config))).slice(0, 16), ...config };
}

export function outputDetail(target: OutputTarget, action: OutputAction, seconds: number) {
  const name = { led: "LED", buzzer: "부저", alarm: "자동 경고음" }[target];
  const text = { on: `${seconds}초 켜기`, test: "2초 시험", off: "30초 끄기", mute: "60초 일시 정지", resume: "일시 정지 해제" }[action];
  return `${name} · ${text}`;
}
