// Test-only transport. Not loaded by the app and never pretends to be real data.
// Self-contained so Playwright can install it before Streamlit starts.
export function installFakeUsb({ install = true, auto = false } = {}) {
  const encode = value => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value) + "\n");
  class Port {
    constructor() { this.opens = 0; this.closes = 0; this.writes = []; this.nextAck = "apply"; this.skipReady = false; this.state = { gasRaw: 120, distanceCm: 12, gasAlarm: false, gasState: "disabled", intrusionAlarm: false, config: 0 }; }
    async open(options) {
      if (this.opened) throw new Error("already open");
      this.opened = true; this.opens++; this.options = options; this.seq = 0; this.epoch = performance.now(); this.manual = { led: 0, buzzer: 0 };
      this.readable = new ReadableStream({ start: c => { this.controller = c; }, cancel: () => { this.controller = null; } });
      this.writable = new WritableStream({ write: bytes => { this.writes.push(new TextDecoder().decode(bytes)); this.receive(JSON.parse(this.writes.at(-1))); } });
      if (auto) this.timer = setInterval(() => { if (this.session && !this.pause) this.sample(); }, 1000);
    }
    async close() {
      if (this.readable?.locked || this.writable?.locked) throw new Error("streams still locked");
      clearInterval(this.timer); this.opened = false; this.controller = null; this.session = null; this.closes++;
    }
    push(value, split = false) {
      if (!this.controller) return;
      const bytes = encode(value);
      if (split) { this.controller.enqueue(bytes.slice(0, 17)); this.controller.enqueue(bytes.slice(17)); }
      else this.controller.enqueue(bytes);
    }
    receive(p) {
      if (p.type === "hello") { this.session = p.session; if (!this.skipReady) this.push({ type: "ready", protocol: "ZIPON_USB_V4", session: p.session }, true); return; }
      if (p.session !== this.session) return;
      if (p.type === "ping") { this.state.intrusionAlarm = p.intrusion; return; }
      if (this.nextAck === "drop") { this.nextAck = "apply"; return; }
      const rejected = this.nextAck === "reject"; this.nextAck = "apply";
      if (!rejected) {
        if (p.type === "manual") this.manual[p.target] = p.on ? performance.now() + p.seconds * 1000 : 0;
        if (p.type === "intrusion") this.state.intrusionAlarm = p.on;
        if (p.type === "config") { this.state.config = p.rev; this.state.gasState = p.gasEnabled ? "below" : "disabled"; }
      }
      this.push({ type: "ack", protocol: "ZIPON_USB_V4", session: this.session, id: p.id, applied: !rejected, reason: rejected ? "invalid" : "applied" });
    }
    sample(overrides = {}) {
      const now = performance.now(), s = this.state;
      const ml = this.manual.led > now, mb = this.manual.buzzer > now;
      const ls = s.gasAlarm ? "gas" : ml ? "manual" : "off", bs = s.gasAlarm ? "gas" : s.intrusionAlarm ? "intrusion" : mb ? "manual" : "off";
      const frame = { type: "telemetry", protocol: "ZIPON_USB_V4", session: this.session, seq: ++this.seq, uptimeMs: Math.floor(now - this.epoch), ...s, led: ls !== "off", buzzer: bs !== "off", manualLed: ml, manualBuzzer: mb, ledSource: ls, buzzerSource: bs, ...overrides };
      this.push(frame, true); return frame;
    }
    fail() { this.controller?.error(new Error("isolated read failure")); this.controller = null; }
  }
  const port = new Port();
  const serial = new EventTarget();
  serial.port = port; serial.chooserCalls = 0;
  serial.requestPort = async () => { serial.chooserCalls++; if (serial.deny) throw new DOMException("isolated permission denial", "NotFoundError"); return port; };
  if (install) { Object.defineProperty(navigator, "serial", { value: serial, configurable: true }); globalThis.ziponTestUsb = serial; }
  return serial;
}
