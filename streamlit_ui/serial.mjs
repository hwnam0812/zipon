import { USB_PROTOCOL, FRESH_MS, parseFrame } from "./model.mjs";

function connectionErrorMessage(error, stage) {
  if (stage === "choosing" && error?.name === "NotFoundError") return "USB 포트 선택을 취소했어요.";
  if (["SecurityError", "NotAllowedError"].includes(error?.name)) return "USB 연결 권한을 확인하지 못했어요. 데스크톱 Chrome·Edge에서 앱을 별도 탭으로 열고 USB 권한을 허용해 주세요.";
  if (stage === "opening") return "USB 포트를 열지 못했어요. Arduino IDE의 시리얼 모니터·플로터, 중계 프로그램과 다른 USB 연결 탭을 닫아 주세요. 계속되면 USB를 뺐다가 다시 꽂고 UNO 포트를 선택해 주세요.";
  return "USB 연결을 시작하지 못했어요. 케이블 연결을 확인하고 앱을 새로고침한 뒤 다시 연결해 주세요.";
}

export class UsbConnection {
  constructor({ onSample, onStatus, onEvent, serial = globalThis.navigator?.serial, now = () => performance.now() }) {
    this.serial = serial; this.onSample = onSample; this.onStatus = onStatus; this.onEvent = onEvent; this.now = now;
    this.port = null; this.savedPort = null; this.reader = null; this.writer = null; this.pending = new Map();
    this.generation = 0; this.lastSample = null; this.receivedAt = 0; this.seq = 0; this.ready = false; this.opening = false;
    this.writeTail = Promise.resolve(); this.intrusion = false; this.counter = 0;
    this.onDisconnect = e => { if (e.target === this.port || e.port === this.port) void this.close("USB 케이블 연결이 끊겼어요."); };
    this.serial?.addEventListener("disconnect", this.onDisconnect);
  }
  get fresh() { return Boolean(this.ready && this.lastSample && this.now() - this.receivedAt < FRESH_MS); }
  status(state, message = "") { this.onStatus?.({ state, message, fresh: this.fresh }); }
  async connect(reconnect = false) {
    if (this.port || this.opening || this.closing) throw new Error("이전 USB 연결을 정리하고 있어요. 연결 해제가 끝난 뒤 다시 눌러 주세요.");
    if (!globalThis.isSecureContext || !this.serial) throw new Error("USB 직접 연결은 보안 연결의 데스크톱 Chrome·Edge에서 사용해 주세요.");
    if (globalThis.document?.permissionsPolicy && !document.permissionsPolicy.allowsFeature("serial")) throw new Error("이 화면의 USB 권한이 막혀 있어요. 앱을 별도 탭에서 열어 주세요.");
    this.opening = true; const gen = ++this.generation;
    this.status("choosing", "UNO의 USB 포트를 선택해 주세요.");
    let port, stage = "choosing", opened = false;
    try {
      // The first requestPort runs directly inside the click's user activation.
      port = reconnect && this.savedPort ? this.savedPort : await this.serial.requestPort();
      if (gen !== this.generation) return;
      this.status("opening", "포트를 열고 새 스케치를 확인하고 있어요.");
      stage = "opening";
      this.port = port; this.savedPort = port;
      await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 2048 });
      opened = true; stage = "streams";
      if (gen !== this.generation) { await port.close().catch(() => {}); return; }
      if (!port.readable || !port.writable) throw new Error("USB 읽기·쓰기를 시작하지 못했어요.");
      this.writer = port.writable.getWriter(); this.reader = port.readable.getReader();
      this.session = [...crypto.getRandomValues(new Uint8Array(8))].map(v => v.toString(16).padStart(2, "0")).join("");
      this.ready = false; this.lastSample = null; this.receivedAt = 0; this.seq = 0; this.counter = 0; this.writeTail = Promise.resolve(); this.intrusion = false;
      this.openingAt = this.now(); this.lastHello = -Infinity; this.lastPing = -Infinity; this.wasFresh = false;
      this.loop = this.readLoop(gen);
      this.timer = setInterval(() => this.tick(), 250);
      this.tick();
    } catch (error) {
      const message = connectionErrorMessage(error, stage);
      // A failed open grants no ownership: never close a port held elsewhere.
      if (!opened && this.port === port) this.port = null;
      if (gen === this.generation) await this.close(message);
      // Keep the actionable message; raw browser English used to overwrite it.
      throw new Error(message);
    } finally { this.opening = false; }
  }
  tick() {
    const now = this.now();
    if (!this.port) return;
    if (!this.ready) {
      if (now - this.openingAt > 8000) { void this.close("새 V4 스케치·9600 설정을 확인하고 다시 연결해 주세요."); return; }
      if (now - this.lastHello >= 1000) { this.lastHello = now; void this.write({ type: "hello", protocol: USB_PROTOCOL, session: this.session }).catch(() => {}); }
      return;
    }
    if (now - this.lastPing >= 750) {
      this.lastPing = now;
      // A blocked/hidden app cannot renew the app-based intrusion alarm forever.
      const intrusion = this.fresh && globalThis.document?.visibilityState !== "hidden" && this.intrusion;
      void this.write({ type: "ping", session: this.session, intrusion }).catch(() => {});
    }
    if (this.wasFresh && !this.fresh) { this.wasFresh = false; this.intrusion = false; this.status("stale", "3.5초 동안 새 측정이 없어요. 현재 출력은 확인되지 않았어요."); this.onEvent?.("stale"); }
    if (this.ready && now - Math.max(this.receivedAt, this.readyAt) > 10000) void this.close("측정 응답이 멈췄어요. 케이블과 스케치를 확인한 뒤 다시 연결해 주세요.");
  }
  write(value) {
    const gen = this.generation, bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
    if (bytes.length > 256) return Promise.reject(new Error("USB 요청이 너무 길어요."));
    const next = this.writeTail.then(async () => {
      if (!this.writer || gen !== this.generation) throw new Error("USB 연결이 종료됐어요.");
      if (value.validUntil !== undefined && !this.fresh) throw new Error("측정이 오래되어 제어를 보내지 않았어요.");
      await this.writer.write(bytes);
    });
    this.writeTail = next.catch(() => {});
    return next;
  }
  async command(type, fields) {
    if (!this.fresh) throw new Error("새 센서값을 받은 뒤 제어해 주세요.");
    if (this.pending.size) throw new Error("이전 보드 응답을 기다려 주세요.");
    if (this.counter === 4294967295) throw new Error("요청 순서를 새로 시작해야 해요. USB를 다시 연결해 주세요.");
    const id = (++this.counter >>> 0).toString(16).padStart(8, "0");
    const validUntil = (this.lastSample.uptimeMs + Math.floor(this.now() - this.receivedAt) + 1800) >>> 0;
    const packet = { type, session: this.session, id, validUntil, ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("보드 실행 응답이 없어요. 실제 출력은 마지막 보고를 확인해 주세요.")); }, 2600);
      this.pending.set(id, { resolve, reject, timer });
      this.write(packet).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  async readLoop(gen) {
    const decoder = new TextDecoder(), reader = this.reader; let line = "", discard = false;
    try {
      while (reader && gen === this.generation) {
        const { value, done } = await reader.read(); if (done) break;
        for (const c of decoder.decode(value, { stream: true })) {
          if (c === "\r") continue;
          if (c === "\n") { if (!discard && line) this.frame(line); line = ""; discard = false; }
          else if (!discard) { if (line.length >= 768) { line = ""; discard = true; this.onEvent?.("protocol_error"); } else line += c; }
        }
      }
    } catch { if (gen === this.generation) this.status("error", "USB 읽기가 중단됐어요."); }
    finally {
      try { reader?.releaseLock(); } catch { /* cancelled */ }
      if (gen === this.generation) { this.reader = null; void this.close("USB 측정 연결이 종료됐어요.", true); }
    }
  }
  frame(line) {
    let packet;
    try { packet = parseFrame(line); } catch (error) { this.lastProtocolError = error.message; this.onEvent?.("protocol_error", error.message); return; }
    if (packet.type === "boot") {
      if (this.ready) { this.onEvent?.("boot"); void this.close("보드가 다시 시작됐어요. 새 연결에서 감시를 확인해 주세요."); }
      return;
    }
    if (packet.session !== this.session) return;
    if (packet.type === "ready") {
      if (!this.ready) { this.ready = true; this.readyAt = this.now(); this.status("waiting", "연결했어요. 첫 센서값을 기다리고 있어요."); this.onEvent?.("connected"); }
      return;
    }
    if (!this.ready) return;
    if (packet.type === "ack") {
      const pending = this.pending.get(packet.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(packet.id); packet.applied ? pending.resolve(packet) : pending.reject(new Error(packet.reason === "alarm_active" ? "자동 경보 중에는 가스 감시 설정을 바꿀 수 없어요." : "보드가 요청을 거절했어요. 설정과 연결을 확인해 주세요.")); }
      return;
    }
    if (packet.type !== "telemetry" || packet.seq <= this.seq) return;
    if (this.wasFresh && !this.fresh) { this.wasFresh = false; this.intrusion = false; this.onEvent?.("stale"); }
    this.seq = packet.seq; this.lastSample = packet; this.receivedAt = this.now(); this.wasFresh = true;
    this.status("connected", "USB에서 새 측정값을 받고 있어요."); this.onSample?.(packet);
  }
  async close(reason = "USB 연결을 해제했어요.", fromReader = false) {
    if (this.closing) return this.closing;
    const hadPort = Boolean(this.port), wasReady = this.ready;
    ++this.generation; this.ready = false; this.intrusion = false; this.opening = false;
    clearInterval(this.timer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("USB 연결이 종료되어 요청 응답을 확인하지 못했어요.")); } this.pending.clear();
    const port = this.port, reader = this.reader, writer = this.writer;
    this.port = this.reader = this.writer = null;
    this.closing = (async () => {
      // Do not queue cancellation behind a hung writer. Board's 3 s deadman is authoritative.
      if (reader && !fromReader) { try { await reader.cancel(); } catch { /* unplug */ } }
      if (!fromReader && this.loop) await this.loop.catch(() => {});
      if (writer) { try { await writer.abort(); } catch { /* unplug */ } try { writer.releaseLock(); } catch { /* already closed */ } }
      if (port) { try { await port.close(); } catch { /* unplug/open cancelled */ } }
      this.lastSample = null; this.seq = 0; this.receivedAt = 0;
      this.status("disconnected", reason);
      if (hadPort && wasReady) this.onEvent?.("disconnected", reason);
    })();
    try { await this.closing; } finally { this.closing = null; }
  }
  async destroy() { this.serial?.removeEventListener("disconnect", this.onDisconnect); await this.close(); }
}
