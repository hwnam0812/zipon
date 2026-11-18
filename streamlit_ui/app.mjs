import { USB_PROTOCOL, MAX_POINTS, MAX_EVENTS, DEFAULT_SETTINGS, EVENT_TITLES, clone, kstParts, inWindows, validateSettings, gasReady, boundedPush, eventRecord } from "./model.mjs";
import { DistanceAnalysis } from "./analysis.mjs";
import { UsbConnection } from "./serial.mjs";

export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z", monitor: "M3 12h4l3-8 4 16 3-8h4", history: "M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2",
  settings: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4", devices: "M12 3v12m-4-4 4 4 4-4M7 4h10v4H7zM6 20h12", usb: "M12 3v13m0-13-3 3m3-3 3 3M7 8v4l5 4m5-8v4l-5 4m-2 4a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  gas: "M12 3c2 4 6 5 6 10a6 6 0 0 1-12 0c0-3 2-6 6-10M12 12c-2 2-3 3-3 5", distance: "M5 4v16M19 4v16M8 12h8m-6-3-3 3 3 3m4-6 3 3-3 3", light: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 3H9z", sound: "M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14", arrow: "m9 5 7 7-7 7", check: "m5 12 4 4L19 6", x: "m6 6 12 12M6 18 18 6", lock: "M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3", info: "M12 8h.01M12 11v6M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0", download: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5", leaf: "M20 4C7 2 2 8 6 16c7 6 15-1 14-12M6 18 16 8", cable: "M7 3v4m4-4v4M5 7h8v3a4 4 0 0 1-8 0zM9 14v3a4 4 0 0 0 8 0v-4m-2 0h4V9h-4z",
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.info}"/></svg>`;
const navs = [["home", "우리 집"], ["monitor", "실시간 모니터링"], ["history", "출입 기록"], ["settings", "알림 설정"], ["devices", "기기 관리"]];
const days = ["일", "월", "화", "수", "목", "금", "토"];
const sourceName = s => ({ off: "꺼짐", manual: "수동 요청", gas: "가스 자동 경보", intrusion: "출입 의심" }[s] || "확인 안 됨");
const timeLabel = t => { try { const k = kstParts(Date.parse(t)); return `${k.date} ${k.clock}`; } catch { return "시각 확인 안 됨"; } };
const field = (name, label, value, attrs = "") => `<label class="z-field"><span>${label}</span><input name="${name}" autocomplete="off" value="${esc(value)}" ${attrs}></label>`;
const badge = (text, tone = "muted") => `<span class="z-badge z-badge--${tone}">${esc(text)}</span>`;

export class ZiponApp {
  constructor(root, { Chart, data, emit }) {
    this.root = root; this.Chart = Chart; this.emit = emit; this.data = data;
    this.settings = clone(data.settings || DEFAULT_SETTINGS); this.draft = clone(this.settings); this.revision = data.settingsRevision || 0;
    this.draftRevision = this.revision;
    this.page = navs.some(n => n[0] === data.initialPage) ? data.initialPage : "home";
    this.points = []; this.localEvents = []; this.unsaved = []; this.acknowledged = new Set(); this.analysis = new DistanceAnalysis(); this.last = null;
    this.connection = { state: "disconnected", message: "USB 연결 전이에요.", fresh: false };
    this.intrusionArmed = false; this.intrusionResult = null; this.chartVisibility = { gas: true, distance: true }; this.charts = {};
    this.pendingRequest = null; this.requestTail = Promise.resolve(); this.lastBackend = performance.now(); this.commandBusy = false; this.backendBusy = false; this.lease = false;
    this.recordFilter = { day: "", kind: "all", offset: 0 }; this.recordResult = { rows: data.events || [], total: data.eventTotal || 0 }; this.isDirty = false; this.gasCommandRevision = 0;
    this.usb = new UsbConnection({ onSample: p => this.sample(p), onStatus: s => { this.connection = s; this.updateLive(); }, onEvent: (type, message) => this.usbEvent(type, message) });
    this.root.classList.add("z-app");
    this.root.innerHTML = `<a class="z-skip" href="#z-main">본문으로 이동</a><aside class="z-sidebar"><a class="z-brand" href="#" data-page="home"><span>${icon("home", 26)}</span><b>집온</b><small>zipon</small></a><p class="z-tagline">우리 집을 잇는 작은 안심</p><nav aria-label="주 메뉴">${this.navigation()}</nav><div class="z-sidebar-bottom"><div class="z-sidebar-note">${icon("leaf", 27)}<b>연결부터, 차근차근</b><p>집의 작은 변화도<br>실제 측정으로 살펴봐요.</p></div><button class="z-family" data-action="logout">${icon("lock")}<span><b>우리 가족</b><small>가족 공간 닫기</small></span>${icon("arrow", 16)}</button></div></aside><div class="z-workspace"><header class="z-topbar"><span class="z-crumb">${icon("home", 16)}<span data-home-name></span>${icon("arrow", 13)}<span data-page-name></span></span><a class="z-mobile-brand" href="#" data-page="home">${icon("home", 22)}집온</a><button class="z-top-family" data-action="logout">${icon("lock", 13)}가족 공간</button></header><main id="z-main" tabindex="-1"></main><footer class="z-footer">집온은 원시 센서 출력을 관찰하는 실습용 도구예요. 인증된 화재·가스 경보기나 보안 장치를 대체하지 않아요.</footer></div><nav class="z-mobile-nav" aria-label="모바일 주 메뉴">${this.navigation()}</nav><div class="z-toast" role="status" hidden></div><dialog class="z-dialog" aria-labelledby="z-dialog-title"><form method="dialog"><button class="z-dialog-x" value="cancel" aria-label="닫기">${icon("x")}</button><h2 id="z-dialog-title"></h2><p data-dialog-body></p><div class="z-dialog-actions"><button value="cancel" class="z-btn">취소</button><button value="apply" class="z-btn z-btn--primary" data-confirm-button>실행</button></div></form></dialog>`;
    this.main = this.root.querySelector("main");
    this.root.querySelector(".z-skip").dataset.action = "skip";
    this.onClick = event => { const button = event.target.closest("[data-action], [data-page]"); if (!button || !this.root.contains(button)) return; if (button.dataset.page) { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); this.navigate(button.dataset.page); } else if (!button.disabled) { if (button.dataset.action === "skip") event.preventDefault(); void this.action(button.dataset.action, button).catch(e => this.toast(e.message, true)); } };
    this.onChange = event => this.change(event);
    this.onSubmit = event => { if (event.target.matches("[data-settings-form]")) { event.preventDefault(); void this.saveSettings().catch(e => this.settingsError(e.message)); } };
    this.root.addEventListener("click", this.onClick); this.root.addEventListener("input", this.onChange); this.root.addEventListener("change", this.onChange); this.root.addEventListener("submit", this.onSubmit);
    this.onVisibility = () => { if (document.hidden) { const armed = this.intrusionArmed; this.usb.intrusion = false; this.intrusionArmed = false; this.analysis.reset(); this.intrusionResult = null; if (armed) this.event("intrusion_stopped", "화면을 숨겨 출입 감시 요청을 종료했어요. 돌아오면 다시 시작해 주세요."); } this.updateLive(); };
    this.onPageHide = () => { void this.usb.close(); };
    this.onBeforeUnload = event => { if (this.isDirty || this.unsaved.length || this.usb.port) { event.preventDefault(); event.returnValue = ""; } };
    document.addEventListener("visibilitychange", this.onVisibility); window.addEventListener("pagehide", this.onPageHide); window.addEventListener("beforeunload", this.onBeforeUnload);
    this.timer = setInterval(() => this.tick(), 500); this.lastFlush = 0;
    this.render();
  }
  navigation() { return navs.map(([id, label]) => `<a href="?page=${id}" data-page="${id}" ${id === this.page ? 'aria-current="page"' : ""}>${icon(id)}<span>${label}</span></a>`).join(""); }
  navigate(page) {
    if (page === this.page) return;
    if (this.isDirty && this.page === "settings") { void this.confirm("저장하지 않은 설정이 있어요", "이 화면을 나가면 수정 중인 내용은 버려져요. 적용된 감시 설정은 바뀌지 않아요.", "수정 버리고 이동").then(ok => { if (ok) { this.isDirty = false; this.draft = clone(this.settings); this.draftRevision = this.revision; this.page = page; this.render(); this.main.focus(); } }); return; }
    this.page = page; this.render(); this.main.focus();
    if (page === "history") void this.loadRecords();
  }
  update(data, emit) {
    this.emit = emit; if (this.data.serverTime !== data.serverTime) this.lastBackend = performance.now(); this.data = data;
    const ownSettingsReply = data.reply?.ok && this.pendingRequest?.id === data.reply?.id && this.pendingRequest?.op === "settings";
    if (data.reply && this.pendingRequest?.id === data.reply.id) {
      const p = this.pendingRequest; clearTimeout(p.timer); this.pendingRequest = null;
      data.reply.ok ? p.resolve(data.reply.result) : p.reject(new Error(data.reply.error || "요청을 처리하지 못했어요."));
    }
    if (data.settingsRevision !== this.revision) {
      const wasArmed = this.intrusionArmed;
      this.settings = clone(data.settings); this.revision = data.settingsRevision;
      this.analysis.reset(); this.intrusionArmed = false; this.usb.intrusion = false; this.intrusionResult = null;
      if (wasArmed) this.event("intrusion_stopped", "설정이 바뀌어 출입 감시를 종료했어요. 새 기준을 확인하고 다시 시작해 주세요.");
      if (!this.isDirty) { this.draft = clone(this.settings); this.draftRevision = this.revision; if (this.page === "settings") this.render(); }
      else if (!ownSettingsReply) this.toast("다른 화면에서 설정이 바뀌었어요. 저장 전에 다시 불러와 주세요.", true);
    }
    this.updateLive(); if (this.page === "home" || this.page === "monitor") this.renderEvents();
  }
  request(op, payload = {}) {
    const run = () => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const packet = { id, op, payload };
      const p = { id, op, resolve, reject, attempts: 0, timer: null };
      const send = () => {
        if (this.destroyed) { reject(new Error("가족 공간이 닫혔어요.")); return; }
        p.attempts++; this.pendingRequest = p; this.emit(packet);
        p.timer = setTimeout(() => { if (p.attempts < 2) send(); else { this.pendingRequest = null; reject(new Error("화면 연결이 지연되고 있어요. 저장 여부를 확인하지 못했어요.")); } }, 6500);
      };
      send();
    });
    const result = this.requestTail.then(run); this.requestTail = result.catch(() => {}); return result;
  }
  toast(message, error = false) {
    const node = this.root.querySelector(".z-toast"); node.textContent = message; node.dataset.error = String(error); node.hidden = false;
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { node.hidden = true; }, error ? 7000 : 4500);
  }
  confirm(title, message, button = "실행") {
    const dialog = this.root.querySelector("dialog"); if (dialog.open) return Promise.resolve(false);
    dialog.querySelector("h2").textContent = title; dialog.querySelector("[data-dialog-body]").textContent = message; dialog.querySelector("[data-confirm-button]").textContent = button;
    dialog.returnValue = "cancel"; dialog.showModal();
    return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "apply"), { once: true }));
  }
  event(kind, detail = "", sample = this.last) {
    const row = eventRecord(kind, sample, detail); boundedPush(this.localEvents, row, MAX_EVENTS);
    if (this.unsaved.length >= MAX_EVENTS) { this.unsaved.shift(); this.droppedEvents = (this.droppedEvents || 0) + 1; }
    this.unsaved.push(row); this.renderEvents(); this.updateLive();
    if (["gas_alert", "intrusion_alert", "quiet_door"].includes(kind)) {
      this.toast(EVENT_TITLES[kind], true);
      try { if (this.browserNotifications && "Notification" in window && Notification.permission === "granted") new Notification(`집온 · ${EVENT_TITLES[kind]}`, { body: "실습용 센서 출력 변화예요. 실제 상황을 직접 확인해 주세요.", tag: row.id }); } catch { /* Saved in-app record remains. */ }
    }
    return row;
  }
  usbEvent(type, detail = "") {
    if (type === "connected") { this.analysis.reset(); this.intrusionArmed = false; this.last = null; this.appliedGas = null; this.faults = null; if (this.points.length) boundedPush(this.points, { time: Date.now(), gas: null, distance: null }, MAX_POINTS); this.event("usb_connected", "V4 · 9600 baud · 새 측정을 기다리고 있어요."); }
    if (type === "disconnected") { this.intrusionArmed = false; this.lease = false; this.analysis.reset(); this.intrusionResult = null; this.event("usb_disconnected", detail); void this.request("release").catch(() => {}); }
    if (type === "stale") { this.intrusionArmed = false; this.usb.intrusion = false; this.analysis.reset(); this.intrusionResult = null; this.event("sensor_error", "새 측정 수신이 중단됐어요. 정상 복귀가 아니에요."); boundedPush(this.points, { time: Date.now(), gas: null, distance: null }, MAX_POINTS); this.updateCharts(); }
    if (type === "boot") this.event("device_boot", "보드가 재시작됐어요. 이전 경보 기록은 보존해요.");
    if (type === "protocol_error" && !this.protocolNoted) { this.protocolNoted = true; this.event("sensor_error", detail || "잘못되거나 너무 긴 USB 메시지를 버렸어요."); }
  }
  sample(p) {
    const before = this.last; this.last = p; this.sampleWallTime = Date.now();
    if (before) {
      if (!before.gasAlarm && p.gasAlarm) this.event("gas_alert", "설정한 ADC 기준을 보드에서 지속 확인했어요. 화재·누출 확정이 아니에요.");
      if (before.gasAlarm && !p.gasAlarm && p.gasState === "below") this.event("gas_clear", "복귀 기준 아래의 지속 출력을 보드에서 확인했어요. 안전 판정은 아니에요.");
      for (const key of ["led", "buzzer"]) if (before[key] !== p[key]) this.event(`${key}_${p[key] ? "on" : "off"}`, `보드 출력 보고 · ${sourceName(p[`${key}Source`])}`);
    } else {
      if (p.gasAlarm) this.event("gas_alert", "연결 직후 보드가 기존 가스 출력 경보를 보고했어요.");
      for (const key of ["led", "buzzer"]) if (p[key]) this.event(`${key}_on`, `첫 보드 보고 · ${sourceName(p[`${key}Source`])}`);
    }
    const faults = { gas: p.gasRaw === null || p.gasRaw === 0 || p.gasState === "fault", distance: p.distanceCm === null };
    for (const key of ["gas", "distance"]) {
      if (faults[key] && !this.faults?.[key]) this.event("sensor_error", key === "gas" ? "가스 원시 출력이 없거나 0이에요. 연결·전원·센서를 직접 확인해 주세요." : "초음파 응답이 없어요. 문 열림이나 사람의 출입으로 판정하지 않아요.");
      if (!faults[key] && this.faults?.[key]) this.event("sensor_recovered", `${key === "gas" ? "가스" : "초음파"} 측정이 다시 들어왔어요. 안전 확인은 아니에요.`);
    }
    this.faults = faults;
    const analysisSettings = clone(this.settings); analysisSettings.intrusion.enabled &&= this.intrusionArmed && this.lease && !document.hidden;
    this.intrusionResult = this.analysis.update(p, analysisSettings, Date.now(), performance.now());
    if (this.intrusionResult.event) this.event(this.intrusionResult.event, this.intrusionResult.event === "intrusion_stopped" ? "측정 중단 또는 감시 종료로 출입 경보 요청을 종료했어요. 정상 복귀 확인이 아니에요." : "허용 시간표·지속 시간·거리 기준에 따른 실습용 판단이에요.");
    if (this.intrusionResult.doorEvent) {
      this.event(this.intrusionResult.doorEvent, "거리 변화일 뿐 실제 사람의 출입을 확정하지 않아요.");
      if (this.intrusionResult.doorEvent === "door_open" && this.settings.quietEnabled && inWindows(this.settings.quietWindows)) this.event("quiet_door", "설정한 안심 시간에 기준 거리 이탈이 확인됐어요.");
    }
    const desired = Boolean(this.intrusionResult.alarm);
    if (desired !== this.usb.intrusion) {
      this.usb.intrusion = desired;
      if (!this.commandBusy && this.lease) void this.usb.command("intrusion", { on: desired }).catch(e => this.toast(e.message, true));
    }
    boundedPush(this.points, { time: Date.now(), gas: faults.gas ? null : p.gasRaw, rawGas: p.gasRaw, distance: p.distanceCm, gasAlert: p.gasAlarm && !before?.gasAlarm, intrusionAlert: this.intrusionResult.event === "intrusion_alert" }, MAX_POINTS);
    this.updateLive(); this.updateCharts();
  }
  tick() {
    if (this.destroyed) return;
    if (this.usb.port && performance.now() - this.lastBackend > 12000) { this.lease = false; this.intrusionArmed = false; this.usb.intrusion = false; void this.usb.close("화면의 연결 확인이 끊겼어요. 가스 자동 경보는 보드 전원이 남으면 계속될 수 있어요."); }
    if (performance.now() - this.lastFlush > 2000 && !this.flushing && (this.unsaved.length || this.usb.fresh)) { this.lastFlush = performance.now(); void this.flush(); }
    this.updateLive();
  }
  async flush() {
    this.flushing = true; const rows = this.unsaved.slice(0, 50);
    const sample = this.usb.fresh && this.lease ? this.last : null;
    try {
      const result = await this.request("sync", { events: rows, sample, sampleAgeMs: sample ? Math.floor(performance.now() - this.usb.receivedAt) : null });
      const sent = new Set(result.acceptedIds || []); this.unsaved = this.unsaved.filter(r => !sent.has(r.id));
      for (const id of sent) this.acknowledged.add(id); if (this.acknowledged.size > MAX_EVENTS * 2) this.acknowledged = new Set([...this.acknowledged].slice(-MAX_EVENTS));
      this.saveError = "";
    } catch (e) { this.saveError = e.message; if (sample) { this.lease = false; this.intrusionArmed = false; this.usb.intrusion = false; void this.usb.close("기록 전송과 연결 권한을 확인하지 못했어요. 다시 연결해 주세요. 보드 가스 경보는 별개예요."); } }
    finally { this.flushing = false; this.updateLive(); this.renderEvents(); }
  }
  async action(action, button) {
    if (action === "skip") { this.main.focus(); this.main.scrollIntoView(); return; }
    if (action === "connect" || action === "reconnect") {
      this.protocolNoted = false;
      // Keep the port chooser in the click gesture; acquire shared ownership in parallel.
      const opening = this.usb.connect(action === "reconnect");
      try { await opening; const result = await this.request("claim", { session: this.usb.session }); this.lease = Boolean(result.claimed); if (!this.lease) throw new Error("다른 화면이 이 집의 USB 연결을 사용하고 있어요."); }
      catch (e) { await this.usb.close(e.message); throw e; }
      this.updateLive(); return;
    }
    if (action === "disconnect") { await this.usb.close(); return; }
    if (action === "logout") {
      if (!await this.confirm("가족 공간을 닫을까요?", "USB 직접 연결을 종료해요. 보드에 전원이 남아 있으면 자체 가스 경보는 계속될 수 있어요.", "가족 공간 닫기")) return;
      await this.usb.close(); await this.flush(); await this.request("logout"); return;
    }
    if (action === "reload-settings") { if (this.isDirty && !await this.confirm("수정한 설정을 버릴까요?", "마지막으로 저장한 설정을 다시 불러와요.", "다시 불러오기")) return; this.isDirty = false; const r = await this.request("refresh"); this.settings = clone(r.settings); this.draft = clone(r.settings); this.revision = this.draftRevision = r.settingsRevision; this.render(); return; }
    if (action === "retry-save") { await this.flush(); return; }
    if (action === "notification") {
      if (!("Notification" in window)) throw new Error("이 브라우저는 직접 알림을 지원하지 않아요. 화면 안 기록은 계속 볼 수 있어요.");
      this.browserNotifications = await Notification.requestPermission() === "granted"; this.toast(this.browserNotifications ? "이 화면을 열어 둔 동안 브라우저 알림을 사용해요." : "브라우저 알림이 허용되지 않았어요."); return;
    }
    if (action === "gas-start" || action === "gas-stop") {
      if (!this.usb.fresh || !this.lease) throw new Error("USB를 연결하고 새 측정값을 받은 뒤 시작해 주세요.");
      if (!gasReady(this.settings)) throw new Error("알림 설정에서 예열·기준값을 직접 확인하고 가스 기준을 먼저 적용해 주세요.");
      if (this.last.gasAlarm) throw new Error("가스 출력 경보가 진행 중이에요. 수동 끄기로 해제하지 않아요.");
      if (!await this.confirm(action === "gas-start" ? "이번 연결에서 가스 감시를 시작할까요?" : "가스 감시를 종료할까요?", action === "gas-start" ? "설정한 원시 ADC 기준의 실습용 감시예요. 센서 예열과 실제 환경을 직접 확인했는지 다시 살펴봐 주세요." : "가스 출력에 따른 자동 경보가 더 이상 시작되지 않아요. 인증 경보기의 동작과는 관계없어요.", action === "gas-start" ? "가스 감시 시작" : "가스 감시 종료")) return;
      const g = this.settings.gas;
      const rev = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
      await this.boardCommand("config", { gasEnabled: action === "gas-start", gasThreshold: g.threshold, gasRecovery: g.recovery, gasHoldMs: g.holdSeconds * 1000, gasRecoveryMs: g.recoverySeconds * 1000, rev }, "가스 감시 설정"); return;
    }
    if (action === "intrusion-start") {
      if (!this.usb.fresh || !this.lease || this.last?.distanceCm === null) throw new Error("USB 연결과 실제 초음파 측정값을 먼저 확인해 주세요.");
      if (!this.settings.intrusion.enabled) throw new Error("알림 설정에서 출입 감시 사용과 허용 시간표를 먼저 적용해 주세요.");
      if (!await this.confirm("이번 연결에서 출입 감시를 시작할까요?", "한국 시간의 허용 시간표 밖에서만 출입 의심 경보를 요청해요. 첫 기준 확인 중에는 출입으로 세지 않아요.", "출입 감시 시작")) return;
      this.analysis.reset(); this.intrusionArmed = true; this.event("monitoring_started", "이번 연결의 출입 감시를 시작했어요. 첫 거리 기준 확인을 기다려요."); this.updateLive(); return;
    }
    if (action === "intrusion-stop") { this.intrusionArmed = false; this.usb.intrusion = false; this.analysis.reset(); this.intrusionResult = null; if (this.usb.fresh && this.lease && !this.commandBusy) await this.boardCommand("intrusion", { on: false }, "출입 감시 요청 종료"); this.event("intrusion_stopped", "사용자가 출입 감시를 종료했어요. 가스 감시는 별개예요."); this.updateLive(); return; }
    if (action.startsWith("manual-")) {
      const [, target, mode] = action.split("-"); const on = mode !== "off", seconds = on ? mode === "test" ? 2 : 15 : 0;
      if (target === "buzzer" && on && !await this.confirm("부저에서 소리가 나요", `${seconds}초 동안 수동 부저를 요청해요. 주변 사람과 동물에게 먼저 알려 주세요. 자동 경보는 별도로 유지돼요.`, mode === "test" ? "부저 2초 시험" : "부저 15초 켜기")) return;
      await this.boardCommand("manual", { target, on, seconds }, `${target === "led" ? "LED" : "부저"} ${on ? `${seconds}초 켜기` : "수동 요청 끄기"}`); return;
    }
    if (action.startsWith("graph-")) { const key = action.slice(6); this.chartVisibility[key] = !this.chartVisibility[key]; this.renderMonitor(); return; }
    if (action === "clear-graph") { if (await this.confirm("이 화면의 그래프만 비울까요?", "저장한 이벤트와 설정은 지우지 않아요.", "그래프 비우기")) { this.points = []; this.updateCharts(); } return; }
    if (action === "add-quiet" || action === "add-allowed") {
      const key = action === "add-quiet" ? "quietWindows" : "allowedWindows", list = key === "quietWindows" ? this.draft.quietWindows : this.draft.intrusion.allowedWindows;
      if (list.length >= 20) throw new Error("시간표는 최대 20개까지 추가할 수 있어요.");
      list.push({ id: crypto.randomUUID(), name: key === "quietWindows" ? "새 안심 시간" : "새 허용 시간", enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] }); this.isDirty = true; this.renderSettings(); return;
    }
    if (action === "remove-window") {
      const key = button.dataset.group, index = Number(button.dataset.index), list = key === "quiet" ? this.draft.quietWindows : this.draft.intrusion.allowedWindows;
      const [row] = list.splice(index, 1); this.undoWindow = { key, index, row }; this.isDirty = true; this.renderSettings(); return;
    }
    if (action === "undo-window") { if (this.undoWindow) { const u = this.undoWindow, list = u.key === "quiet" ? this.draft.quietWindows : this.draft.intrusion.allowedWindows; if (list.length < 20) list.splice(u.index, 0, u.row); this.undoWindow = null; this.isDirty = true; this.renderSettings(); } return; }
    if (action === "history-prev" || action === "history-next") { this.recordFilter.offset = Math.max(0, this.recordFilter.offset + (action === "history-prev" ? -50 : 50)); await this.loadRecords(); return; }
    if (action === "export") { const r = await this.request("export", this.recordFilter); this.download(JSON.stringify(r, null, 2), `집온-기록-${kstParts().date}.json`, "application/json"); return; }
    if (action === "import") {
      if (this.importRead) await this.importRead;
      if (!this.importData) throw new Error("먼저 집온 기록 JSON 파일을 선택해 주세요.");
      const selected = this.importData, version = this.importVersion;
      const includeSettings = Boolean(this.root.querySelector("[name=importSettings]")?.checked);
      if (includeSettings && this.usb.port) throw new Error("설정도 가져오려면 먼저 USB 연결을 해제해 주세요.");
      const info = await this.request("inspect_import", { data: selected });
      if (version !== this.importVersion) throw new Error("선택한 파일이 바뀌었어요. 내용을 확인하고 다시 가져와 주세요.");
      if (!await this.confirm("이전 기록을 가져올까요?", `${info.records}건을 확인했어요. 같은 식별값의 기록은 건너뛰어요.${includeSettings ? " 현재 설정도 선택한 자료로 변경해요. 감시는 자동으로 시작하지 않아요." : " 현재 설정은 바꾸지 않아요."}`, "기록 가져오기")) return;
      const r = await this.request("import", { data: selected, includeSettings, revision: this.revision }); this.toast(`${r.inserted}건을 ${r.persistent ? "가져왔어요" : "이번 접속에만 가져왔어요"}.`);
      if (version === this.importVersion) { this.importData = null; const input = this.root.querySelector('[name="importFile"]'); if (input) input.value = ""; }
      this.isDirty = false; await this.loadRecords(); return;
    }
    if (action === "download") { const r = await this.request("download", { name: button.dataset.file }); const bytes = Uint8Array.from(atob(r.content), c => c.charCodeAt(0)); this.download(bytes, r.filename, r.mime); return; }
  }
  async boardCommand(type, fields, description) {
    if (this.commandBusy || !this.usb.fresh || !this.lease) throw new Error("USB 연결과 새 측정값·이전 요청 응답을 확인해 주세요.");
    this.commandBusy = true; this.event("command_requested", description); this.updateLive();
    try { const reply = await this.usb.command(type, fields); if (type === "config") this.appliedGas = clone(fields); this.event("command_applied", `${description} · 요청 ${reply.id}. 실제 빛·소리는 직접 확인해야 해요.`); this.commandNote = `${description}: 보드 실행 응답을 받았어요. 마지막 출력 보고와는 별개예요.`; this.toast("보드 실행 응답을 받았어요. 현재 출력 보고를 기다려 주세요."); }
    catch (e) { this.event(e.message.includes("응답이 없") ? "command_expired" : "command_rejected", `${description} · ${e.message}`); this.commandNote = e.message; throw e; }
    finally { this.commandBusy = false; this.updateLive(); }
  }
  async saveSettings() {
    if (this.savingSettings) return;
    const settings = validateSettings(this.draft);
    if (this.last?.gasAlarm) {
      if (JSON.stringify(settings.gas) !== JSON.stringify(this.settings.gas)) throw new Error("가스 경보 중에는 가스 기준을 바꾸지 않아요.");
    }
    this.savingSettings = true;
    const submit = this.root.querySelector('[data-settings-form] button[type="submit"]'); if (submit) { submit.disabled = true; submit.textContent = "적용 중…"; }
    let r;
    try { r = await this.request("settings", { settings, revision: this.draftRevision }); }
    finally { this.savingSettings = false; if (submit) { submit.disabled = false; submit.textContent = this.data.durable ? "설정 저장" : "이번 접속에 적용"; } }
    this.settings = clone(r.settings); this.draft = clone(r.settings); this.revision = this.draftRevision = r.settingsRevision; this.isDirty = false;
    this.analysis.reset(); this.intrusionArmed = false; this.usb.intrusion = false; this.intrusionResult = null;
    this.event("settings_saved", "설정을 적용했어요. 가스 기준은 USB에서 감시 시작을 눌러 보드에 적용해야 해요. 출입 감시는 다시 시작해 주세요.");
    this.toast(r.persistent ? "설정을 저장했어요. 보드 감시는 별도로 시작해 주세요." : "이번 접속에만 적용했어요. 영구 저장은 준비되지 않았어요."); this.render();
  }
  settingsError(message) {
    const form = this.root.querySelector("[data-settings-form]"); if (!form) { this.toast(message, true); return; }
    let node = form.querySelector("[data-settings-error]");
    if (!node) { node = document.createElement("p"); node.dataset.settingsError = ""; node.className = "z-error"; node.setAttribute("role", "alert"); node.tabIndex = -1; form.prepend(node); }
    node.textContent = message; node.hidden = false; node.focus();
  }
  change(event) {
    const input = event.target; if (!input.name) return;
    if (input.name === "historyDay" || input.name === "historyKind") { if (event.type !== "change") return; this.recordFilter[input.name === "historyDay" ? "day" : "kind"] = input.value; this.recordFilter.offset = 0; void this.loadRecords(); return; }
    if (input.name === "importFile") {
      if (event.type !== "change") return;
      const version = this.importVersion = (this.importVersion || 0) + 1;
      this.importData = null; this.importRead = null;
      const file = input.files?.[0]; if (!file) return;
      if (file.size > 2000000) { input.value = ""; this.toast("기록 파일은 2MB 이하로 선택해 주세요.", true); return; }
      this.importRead = file.text().then(text => { if (version !== this.importVersion) return; this.importData = JSON.parse(text); this.toast(`${file.name}을 읽었어요. 가져오기를 누르면 내용을 확인해요.`); })
        .catch(() => { if (version === this.importVersion) this.toast("JSON 파일을 읽지 못했어요. 올바른 집온 기록 파일을 다시 선택해 주세요.", true); })
        .finally(() => { if (version === this.importVersion) this.importRead = null; }); return;
    }
    if (!input.closest("[data-settings-form]")) return;
    const error = this.root.querySelector("[data-settings-error]"); if (error) error.hidden = true;
    const parts = input.name.split(".");
    if (parts[0] === "window") {
      const list = parts[1] === "quiet" ? this.draft.quietWindows : this.draft.intrusion.allowedWindows, w = list[Number(parts[2])]; if (!w) return;
      if (parts[3] === "days") { const day = Number(parts[4]); w.days = input.checked ? [...new Set([...w.days, day])] : w.days.filter(d => d !== day); }
      else w[parts[3]] = input.type === "checkbox" ? input.checked : input.value;
    } else {
      let obj = this.draft; for (const p of parts.slice(0, -1)) obj = obj[p];
      obj[parts.at(-1)] = input.type === "checkbox" ? input.checked : input.type === "number" ? input.value === "" ? null : Number(input.value) : input.value;
    }
    this.isDirty = true;
    const note = this.root.querySelector("[data-dirty]"); if (note) note.textContent = "아직 적용하지 않은 변경이 있어요.";
  }
  async loadRecords() {
    this.recordsLoading = true; if (this.page === "history") this.renderHistory();
    try { this.recordResult = await this.request("events", this.recordFilter); this.recordsError = ""; }
    catch (e) { this.recordsError = e.message; }
    finally { this.recordsLoading = false; if (this.page === "history") this.renderHistory(); }
  }
  download(content, name, mime) { const blob = new Blob([content], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; this.root.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  render() {
    const url = new URL(window.location.href); url.searchParams.set("page", this.page); window.history.replaceState(null, "", url);
    for (const a of this.root.querySelectorAll("[data-page]")) a.dataset.page === this.page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
    this.root.querySelector("[data-home-name]").textContent = this.settings.homeName;
    this.root.querySelector("[data-page-name]").textContent = navs.find(n => n[0] === this.page)?.[1] || "우리 집";
    this.destroyCharts();
    if (this.page === "monitor") this.renderMonitor(); else if (this.page === "settings") this.renderSettings(); else if (this.page === "history") this.renderHistory(); else if (this.page === "devices") this.renderDevices(); else this.renderHome();
    this.updateLive();
  }
  heading(title, description, eyebrow = "우리 집의 작은 변화까지") { return `<div class="z-heading"><p>${esc(eyebrow)}</p><h1>${title}</h1><span>${description}</span></div>${this.storageNotice()}<div class="z-sync-note" data-storage-error role="status" hidden></div>`; }
  storageNotice() {
    return `<div class="z-storage-note" data-storage role="status">${icon("info", 17)}<span>${this.data.durable ? "설정과 이벤트는 가족 공간에 보관해요. 그래프는 이 접속의 최근 600개만 보여요." : this.data.mode === "development" ? "개발 확인용 임시 저장이에요. Streamlit에서 계속 보관하려면 외부 영구 저장소를 연결해 주세요." : "영구 저장소가 연결되지 않았어요. 설정과 기록은 이번 접속에만 남고 다시 접속하면 사라져요."}</span></div><div class="z-sync-note" data-sync hidden></div>`;
  }
  connectionCard() {
    return `<section class="z-connect"><span class="z-connect-icon">${icon("usb", 28)}</span><div><div class="z-connect-title"><h2>우리 집 UNO</h2><span data-live="connectionBadge" class="z-badge z-badge--muted">연결 전</span></div><p data-live="connectionMessage">USB 연결 전이에요.</p><small>USB 직접 연결 · V4 · 9600 baud</small></div><div class="z-connect-actions"><button class="z-btn z-btn--primary" data-action="connect">${icon("usb", 17)}USB 연결</button><button class="z-btn" data-action="reconnect" hidden>다시 연결</button><button class="z-btn" data-action="disconnect" hidden>연결 해제</button></div></section>`;
  }
  metrics() {
    return `<div class="z-metrics"><section class="z-sensor"><div class="z-sensor-title"><span>${icon("gas")}가스 센서</span><span class="z-badge z-badge--muted" data-live="gasState">연결 전</span></div><p class="z-number"><b data-live="gasValue">—</b><span>ADC</span></p><p class="z-sensor-note" data-live="gasNote">가스 농도가 아닌 원시 출력이에요.</p><div class="z-sensor-bottom"><span>화재·가스 위험 의심</span><strong data-live="gasAlarm">확인 안 됨</strong></div></section><section class="z-sensor"><div class="z-sensor-title"><span>${icon("distance")}초음파 센서</span><span class="z-badge z-badge--muted" data-live="distanceState">연결 전</span></div><p class="z-number"><b data-live="distanceValue">—</b><span>cm</span></p><p class="z-sensor-note" data-live="distanceNote">실제 사람의 출입을 확정하지 않아요.</p><div class="z-sensor-bottom"><span>출입 의심</span><strong data-live="intrusionState">감시 꺼짐</strong></div></section></div><div class="z-output-summary"><div>${icon("light")}<span>LED 마지막 보고</span><b data-live="ledValue">확인 안 됨</b><small data-live="ledSource">직접 연결 후 확인해요.</small></div><div>${icon("sound")}<span>부저 마지막 보고</span><b data-live="buzzerValue">확인 안 됨</b><small data-live="buzzerSource">직접 연결 후 확인해요.</small></div><div>${icon("history")}<span>마지막 측정</span><b data-live="lastSeen">아직 없어요</b><small>요청이나 응답 시각과 달라요.</small></div></div><div class="z-alarm" role="alert" data-alarm hidden></div>`;
  }
  controls() {
    return `<section class="z-panel"><div class="z-section-head"><div><h2>출력 직접 제어</h2><p>수동 요청과 자동 경보는 따로 관리해요.</p></div>${badge("최대 15초")}</div><div class="z-control-grid">${[["led", "LED", "light"], ["buzzer", "부저", "sound"]].map(([target, label, symbol]) => `<div class="z-control-unit"><h3>${icon(symbol)}${label}<span data-live="${target}Control">확인 안 됨</span></h3><div class="z-buttons"><button class="z-btn z-btn--primary" data-action="manual-${target}-on" data-control disabled>${label} 15초 켜기</button><button class="z-btn" data-action="manual-${target}-off" data-control disabled>수동 ${label} 끄기</button><button class="z-btn" data-action="manual-${target}-test" data-control disabled>2초 시험</button></div><small data-live="${target}Manual">수동 요청이 없어요.</small></div>`).join("")}</div><p class="z-command-note" data-live="commandNote">아직 요청하지 않았어요. 소프트웨어 응답은 실제 빛·소리의 증거가 아니에요.</p><p class="z-footnote">자동 경보 중 수동 끄기를 눌러도 자동 출력은 유지돼요. 가스 → 출입 의심 → 유효한 수동 요청 순서예요.</p></section><section class="z-panel z-arm-panel"><div><h2>이번 연결의 감시</h2><p>저장한 설정만으로 감시를 시작하지 않아요.</p></div><div class="z-arm-row"><span>가스 출력 감시 <b data-live="gasMonitoring">꺼짐</b></span><div class="z-buttons"><button class="z-btn" data-action="gas-start" data-control disabled>가스 감시 시작</button><button class="z-btn" data-action="gas-stop" data-control disabled>가스 감시 종료</button></div></div><div class="z-arm-row"><span>출입 의심 감시 <b data-live="intrusionMonitoring">꺼짐</b></span><div class="z-buttons"><button class="z-btn" data-action="intrusion-start" data-control disabled>출입 감시 시작</button><button class="z-btn" data-action="intrusion-stop" data-control disabled>출입 감시 종료</button></div></div><p class="z-footnote">가스 기준·예열 확인과 출입 허용 시간표는 <button class="z-text-button" data-page="settings">알림 설정</button>에서 정해요. 화면을 숨기면 출입 감시는 종료해요.</p></section>`;
  }
  renderHome() {
    this.main.innerHTML = this.heading("우리 집 한눈에", "집의 작은 변화도, 연결 상태부터 차근차근 살펴봐요.") + `<section class="z-home-banner"><div>${badge("우리 집 실습용 모니터", "green")}<h2>연결한 만큼,<br>알 수 있는 우리 집</h2><p>센서가 보내지 않은 소식은 추측하지 않아요.<br>실제 측정과 마지막 보고를 구분해 보여드려요.</p><button class="z-btn z-btn--primary" data-page="monitor">실시간 모니터링 열기 ${icon("arrow", 16)}</button></div><svg class="z-house-art" viewBox="0 0 260 180" aria-hidden="true"><ellipse cx="136" cy="154" rx="109" ry="14" fill="#e1ebdf"/><path d="m49 83 76-61 77 61v65H49z" fill="#fff" stroke="#86a17b" stroke-width="2"/><path d="m34 87 90-73 93 73" stroke="#527b4c" stroke-width="9" stroke-linecap="round" fill="none"/><rect x="109" y="103" width="34" height="45" rx="3" fill="#bed0b2"/><rect x="66" y="91" width="24" height="25" rx="3" fill="#e7eee2"/><rect x="162" y="91" width="24" height="25" rx="3" fill="#e7eee2"/><path d="M223 143v-29m0 14c-19-2-23-17-14-21 13-2 14 17 14 17m0-6c4-17 20-20 22-10 1 9-14 13-22 13" fill="#a7bf95" stroke="#7b9c69" stroke-width="2"/><path d="M25 146v-22m0 9c-18-5-18-18-10-18 9-1 10 13 10 13m0 1c4-17 18-16 18-8-1 7-11 10-18 10" fill="#b7cba7" stroke="#7b9c69" stroke-width="2"/></svg></section>` + this.metrics() + `<div class="z-home-bottom"><section class="z-panel"><div class="z-section-head"><div><h2>우리 집 최근 기록</h2><p>측정·출력·연결의 변화를 모아요.</p></div><button class="z-text-button" data-page="history">전체 기록 ${icon("arrow", 14)}</button></div><div data-events></div></section><section class="z-panel"><h2>안심 시간</h2><p class="z-description">이 시간의 거리 이탈은 화면 알림으로 남겨요. 출입 경보의 허용 시간표와는 달라요.</p>${this.settings.quietEnabled && this.settings.quietWindows.some(w => w.enabled) ? this.settings.quietWindows.filter(w => w.enabled).map(w => `<div class="z-quiet-summary"><b>${esc(w.name)}</b><span>${esc(w.start)}–${esc(w.end)}</span><small>${w.days.length === 7 ? "매일" : w.days.map(d => days[d]).join("·")}</small></div>`).join("") : `<p class="z-empty-small">사용 중인 안심 시간이 없어요.</p>`}<button class="z-text-button" data-page="settings">안심 시간 관리 ${icon("arrow", 14)}</button></section></div>`;
    this.renderEvents();
  }
  renderMonitor() {
    this.destroyCharts();
    this.main.innerHTML = this.heading("실시간 모니터링", "USB로 연결한 UNO의 실제 측정과 작동 상태를 살펴봐요.", "연결된 순간부터, 있는 그대로") + this.connectionCard() + this.metrics() + `<section class="z-chart-section"><div class="z-section-head"><div><h2>시간에 따른 변화</h2><p>최근 600개 · 새로고침하면 다시 시작해요.</p></div><div class="z-chart-toggles"><button class="z-btn z-btn--small" data-action="graph-gas" aria-pressed="${this.chartVisibility.gas}">${icon("gas", 15)}가스 그래프</button><button class="z-btn z-btn--small" data-action="graph-distance" aria-pressed="${this.chartVisibility.distance}">${icon("distance", 15)}거리 그래프</button><button class="z-text-button" data-action="clear-graph">그래프 비우기</button></div></div><div class="z-charts">${this.chartVisibility.gas ? this.chartCard("gas", "가스 센서 변화", "원시 ADC · 농도 환산 없음") : ""}${this.chartVisibility.distance ? this.chartCard("distance", "초음파 거리 변화", "cm · 실제 출입 확정 아님") : ""}</div>${!this.chartVisibility.gas && !this.chartVisibility.distance ? `<div class="z-empty">보고 싶은 센서의 그래프를 켜 주세요.</div>` : ""}<details class="z-data-table"><summary>최근 측정 10개를 표로 보기</summary><div data-sample-table></div></details></section>` + this.controls() + `<section class="z-panel"><div class="z-section-head"><div><h2>이벤트 기록</h2><p>최신 기록부터 보여요. 실제 측정이 있어야 감지 기록이 생겨요.</p></div><button class="z-text-button" data-page="history">전체 기록 ${icon("arrow", 14)}</button></div><div data-events></div></section>`;
    this.createCharts(); this.updateLive(); this.renderEvents(); this.updateCharts();
  }
  chartCard(key, title, description) { return `<section class="z-chart-card"><div class="z-chart-title"><h3>${title}</h3><small>${description}</small></div><div class="z-chart-wrap"><canvas data-chart="${key}" role="img" aria-label="${title}. 아래 표에서도 최근 측정값을 볼 수 있어요."></canvas><div class="z-chart-empty" data-empty-chart="${key}">${icon(key === "gas" ? "gas" : "distance", 27)}<p>아직 측정값이 없어요</p><span>USB 연결 후 실제 측정이 여기에 쌓여요.</span></div></div><div class="z-chart-legend"><span><i></i>실제 측정</span><span><i class="z-dashed"></i>${key === "gas" ? "경보 기준" : "기준 거리"}</span><span><i class="z-red-dot"></i>${key === "gas" ? "경보 발생" : "출입 의심"}</span></div></section>`; }
  createCharts() {
    if (!this.Chart) { this.toast("그래프 표시 도구를 읽지 못했어요. 수치와 기록은 확인할 수 있어요.", true); return; }
    for (const canvas of this.root.querySelectorAll("[data-chart]")) {
      const key = canvas.dataset.chart;
      this.charts[key] = new this.Chart(canvas, { type: "line", data: { datasets: [{ label: key === "gas" ? "원시 ADC" : "거리(cm)", data: [], borderColor: "#638754", backgroundColor: "#63875412", borderWidth: 2, pointRadius: 0, fill: true, spanGaps: false, tension: .18 }, { label: key === "gas" ? "경보 기준" : "기준 거리", data: [], borderColor: "#b4785b", borderDash: [5, 5], borderWidth: 1.3, pointRadius: 0 }, { label: "경보 발생", data: [], type: "scatter", backgroundColor: "#bb514a", pointRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true, interaction: { mode: "nearest", axis: "x", intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => items.length ? kstParts(items[0].parsed.x).clock : "" } } }, scales: { x: { type: "linear", grid: { display: false }, ticks: { maxTicksLimit: 5, color: "#647266", font: { size: 10 }, callback: value => kstParts(Number(value)).clock.slice(3) } }, y: { min: 0, ...(key === "gas" ? { max: 1023 } : { suggestedMax: 50 }), grid: { color: "#edf1ed" }, ticks: { maxTicksLimit: 5, color: "#647266", font: { size: 10 } } } } } });
    }
  }
  updateCharts() {
    for (const [key, chart] of Object.entries(this.charts)) {
      const values = this.points.map(p => ({ x: p.time, y: p[key] }));
      const threshold = key === "gas" ? this.settings.gas.threshold : this.settings.intrusion.baselineCm;
      chart.data.datasets[0].data = values;
      chart.data.datasets[1].data = values.length && threshold !== null ? [{ x: values[0].x, y: threshold }, { x: values.at(-1).x, y: threshold }] : [];
      chart.data.datasets[2].data = this.points.filter(p => p[key === "gas" ? "gasAlert" : "intrusionAlert"] && p[key] !== null).map(p => ({ x: p.time, y: p[key] }));
      chart.update("none");
      const empty = this.root.querySelector(`[data-empty-chart="${key}"]`); if (empty) empty.hidden = !this.points.every(p => p[key] === null);
    }
    const table = this.root.querySelector("[data-sample-table]");
    if (table) table.innerHTML = this.points.length ? `<table><caption>최근 실제 측정값 · 한국 시간</caption><thead><tr><th scope="col">시각</th><th scope="col">ADC</th><th scope="col">거리(cm)</th></tr></thead><tbody>${this.points.slice(-10).reverse().map(p => `<tr><td>${kstParts(p.time).clock}</td><td>${p.gas ?? "측정 없음"}</td><td>${p.distance ?? "응답 없음"}</td></tr>`).join("")}</tbody></table>` : `<p>아직 측정값이 없어요.</p>`;
  }
  destroyCharts() { for (const chart of Object.values(this.charts)) chart.destroy(); this.charts = {}; }
  windowEditor(group, list) {
    return `<div class="z-windows">${list.map((w, index) => `<fieldset class="z-window"><legend>${group === "quiet" ? "안심 시간" : "출입 허용 시간"} ${index + 1}</legend><div class="z-window-title">${field(`window.${group}.${index}.name`, "시간 이름", w.name, 'maxlength="24" required')}<label class="z-check"><input type="checkbox" name="window.${group}.${index}.enabled" ${w.enabled ? "checked" : ""}>사용</label><button type="button" class="z-text-button z-danger-text" data-action="remove-window" data-group="${group}" data-index="${index}" aria-label="${esc(w.name)} 삭제">삭제</button></div><div class="z-window-times">${field(`window.${group}.${index}.start`, "시작 시간", w.start, 'type="time" required')}${field(`window.${group}.${index}.end`, "종료 시간", w.end, 'type="time" required')}</div><div class="z-weekdays" role="group" aria-label="반복 요일">${[1, 2, 3, 4, 5, 6, 0].map(day => `<label><input type="checkbox" name="window.${group}.${index}.days.${day}" ${w.days.includes(day) ? "checked" : ""}><span>${days[day]}</span></label>`).join("")}</div></fieldset>`).join("") || `<p class="z-empty-small">${group === "quiet" ? "추가한 안심 시간이 없어요." : "허용 시간이 없으면 모든 시간이 허용 시간 밖이에요. 출입 감시를 켜기 전에 확인해 주세요."}</p>`}</div>`;
  }
  renderSettings() {
    const s = this.draft, g = s.gas, i = s.intrusion;
    const numberField = (name, label, value, min, max, step = 1) => field(name, name === "gas.recoverySeconds" ? "가스 복귀 지속 확인(초)" : label, value, `type="number" min="${min}" max="${max}" step="${step}"`);
    this.main.innerHTML = this.heading("알림 설정", "안심 시간과 실습용 감지 기준을 우리 집에 맞게 정해요.") + `<form data-settings-form><section class="z-panel"><h2>우리 집 이름</h2>${field("homeName", "집 이름 *", s.homeName, 'maxlength="20" required')}</section><section class="z-panel"><div class="z-section-head"><div><h2>안심 시간</h2><p>이 시간의 거리 이탈은 알림으로 남겨요. 보드 출력 시간표는 아니에요.</p></div><label class="z-check"><input type="checkbox" name="quietEnabled" ${s.quietEnabled ? "checked" : ""}>안심 시간 사용</label></div>${this.windowEditor("quiet", s.quietWindows)}<button type="button" class="z-btn" data-action="add-quiet">+ 안심 시간 추가</button></section><section class="z-panel"><div class="z-section-head"><div><h2>가스 원시 출력 감시</h2><p>화재·누출 판정이 아닌 ADC 변화 실습이에요. 검증된 안전 기준값은 없어요.</p></div>${badge("보드에서 지속 판단")}</div><div class="z-form-grid">${numberField("gas.baseline", "직접 확인한 기준 ADC", g.baseline, 1, 1022)}${numberField("gas.threshold", "경보 기준 ADC", g.threshold, 1, 1022)}${numberField("gas.recovery", "복귀 기준 ADC", g.recovery, 1, 1022)}${numberField("gas.holdSeconds", "경보 지속 확인(초)", g.holdSeconds, 5, 60)}${numberField("gas.recoverySeconds", "복귀 지속 확인(초)", g.recoverySeconds, 5, 60)}</div><label class="z-check z-check--wrap"><input type="checkbox" name="gas.warmupConfirmed" ${g.warmupConfirmed ? "checked" : ""}>제조사 안내에 따른 예열과 실제 기준 출력을 직접 확인했어요.</label><p class="z-footnote">기준값 ≤ 복귀 기준 &lt; 경보 기준으로 설정해요. 순간적인 변화나 0·실패로 경보를 해제하지 않아요. 설정 적용 후 모니터링에서 이번 연결의 감시를 따로 시작해요.</p></section><section class="z-panel"><div class="z-section-head"><div><h2>출입 의심 감시</h2><p>허용 시간 밖의 지속적인 거리 변화만 감지해요.</p></div><label class="z-check"><input type="checkbox" name="intrusion.enabled" ${i.enabled ? "checked" : ""}>출입 감시 사용</label></div><div class="z-form-grid">${numberField("intrusion.baselineCm", "기준 거리(cm)", i.baselineCm, 2, 390, .1)}${numberField("intrusion.deltaCm", "최소 변화량(cm)", i.deltaCm, 2, 100, .1)}${numberField("intrusion.holdSeconds", "변화 지속 확인(초)", i.holdSeconds, 1, 30)}${numberField("intrusion.recoverySeconds", "복귀 지속 확인(초)", i.recoverySeconds, 1, 30)}${numberField("intrusion.cooldownSeconds", "반복 방지 시간(초)", i.cooldownSeconds, 5, 600)}</div><h3>출입 허용 시간표</h3><p class="z-description">한국 시간이에요. 자정을 넘으면 시작 요일을 따라요. 허용 시간 안에는 출입 의심 경보를 요청하지 않아요.</p>${this.windowEditor("allowed", i.allowedWindows)}<button type="button" class="z-btn" data-action="add-allowed">+ 허용 시간 추가</button><p class="z-footnote">초기 거리·오류 후 첫 복구값은 출입으로 세지 않아요. 허용 시간표가 비어 있으면 모든 시간이 허용 시간 밖이에요. 처음 기준 거리 안쪽을 확인한 뒤 감지할 수 있어요.</p></section><div class="z-settings-save"><span data-dirty>${this.isDirty ? "아직 적용하지 않은 변경이 있어요." : "저장한 기준과 실제 보드 적용은 별개예요."}</span>${this.undoWindow ? '<button type="button" class="z-text-button" data-action="undo-window">시간 삭제 되돌리기</button>' : ""}<button type="button" class="z-btn" data-action="reload-settings">다시 불러오기</button><button type="submit" class="z-btn z-btn--primary">${this.data.durable ? "설정 저장" : "이번 접속에 적용"}</button></div></form><section class="z-panel"><h2>브라우저 알림</h2><p class="z-description">이 화면을 열어 둔 동안만 사용할 수 있어요. 앱 종료·잠금 중 비상 알림은 없어요.</p><button class="z-btn" data-action="notification">브라우저 알림 사용</button></section>`;
  }
  eventsHtml(rows, limit = 8) {
    if (!rows.length) return `<div class="z-empty">${icon("history", 27)}<h3>아직 기록이 없어요</h3><p>USB를 연결하고 실제 변화가 생기면 여기에 남아요.</p></div>`;
    return `<ol class="z-event-list">${rows.slice(0, limit).map(r => `<li><span class="z-event-icon ${["gas_alert", "intrusion_alert", "sensor_error"].includes(r.kind) ? "z-event-icon--alert" : ""}">${icon(r.kind.startsWith("gas") ? "gas" : r.kind.startsWith("usb") ? "usb" : r.kind.startsWith("led") ? "light" : r.kind.startsWith("buzzer") ? "sound" : "history", 17)}</span><div class="z-event-body"><div><h3>${esc(r.legacy && r.title || EVENT_TITLES[r.kind] || (r.legacy ? "이전 기록 · " + r.kind : r.kind))}</h3>${r.legacy ? badge("이전 기록") : !this.acknowledged.has(r.id) && this.unsaved.some(e => e.id === r.id) ? badge("전송 대기", "amber") : !this.data.durable ? badge("임시 기록") : ""}</div><p>${esc(r.detail)}</p><small>ADC ${r.gas_raw ?? "—"} · 거리 ${r.distance_cm ?? "—"}cm · LED ${r.led === null ? "—" : r.led ? "켜짐" : "꺼짐"} · 부저 ${r.buzzer === null ? "—" : r.buzzer ? "작동" : "정지"}</small><time datetime="${esc(r.created_at)}">${timeLabel(r.created_at)}</time></div></li>`).join("")}</ol>`;
  }
  recentEvents() { const map = new Map(); for (const r of [...(this.data.events || []), ...this.localEvents]) map.set(r.id, r); return [...map.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50); }
  renderEvents() { for (const node of this.root.querySelectorAll("[data-events]")) node.innerHTML = this.eventsHtml(this.recentEvents()); }
  renderHistory() {
    const f = this.recordFilter, r = this.recordResult;
    this.main.innerHTML = this.heading("출입·감지 기록", "발생 시각의 수치와 출력 보고를 함께 확인해요. 시각은 한국 시간이에요.") + `<section class="z-panel"><div class="z-history-filter">${field("historyDay", "날짜", f.day, 'type="date"')}<label class="z-field"><span id="z-history-kind-label">기록 종류</span><select name="historyKind" aria-labelledby="z-history-kind-label">${[["all", "전체"], ["gas", "가스 출력"], ["intrusion", "출입 의심"], ["door", "거리 변화"], ["usb", "USB 연결"], ["sensor", "센서 오류·복구"], ["led", "LED"], ["buzzer", "부저"], ["command", "제어 요청·응답"]].map(([v, label]) => `<option value="${v}" ${f.kind === v ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="z-btn" data-action="export">${icon("download", 16)}기록 내보내기</button></div>${this.recordsError ? `<p class="z-error" role="alert">${esc(this.recordsError)}</p>` : ""}${this.recordsLoading ? '<p class="z-empty" role="status">기록을 불러오고 있어요.</p>' : this.eventsHtml(r.rows, 50)}<div class="z-pagination"><span>전체 ${Number(r.total).toLocaleString("ko-KR")}건 · 한 번에 50건</span><div><button class="z-btn z-btn--small" data-action="history-prev" ${!f.offset || this.recordsLoading ? "disabled" : ""}>이전</button><button class="z-btn z-btn--small" data-action="history-next" ${f.offset + 50 >= r.total || this.recordsLoading ? "disabled" : ""}>다음</button></div></div></section>`;
  }
  renderDevices() {
    this.main.innerHTML = this.heading("기기 관리", "현재 배선을 유지하고, 새 스케치와 USB 연결을 함께 준비해요.") + this.connectionCard() + `<section class="z-panel"><div class="z-section-head"><div><h2>UNO R3 · USB V4</h2><p>새 직접 연결은 기존 V3 중계와 통신 형식이 달라요.</p></div>${badge("실물 검증 필요", "amber")}</div><div class="z-pin-grid">${[["가스 센서 AO", "A5"], ["초음파 Trig", "D9"], ["초음파 Echo", "D11"], ["수동 피에조", "D6"], ["LED + 330Ω", "D8"]].map(([label, pin]) => `<div><span>${label}</span><b>${pin}</b></div>`).join("")}</div><p class="z-description">MQ-135는 별도 안정화 5V, UNO와 공통 GND를 사용해요. 외부 전원의 +와 UNO 5V/VIN을 합치지 않아요. 모듈의 실제 핀 글씨와 피에조 구동 조건을 먼저 확인해 주세요. DO·D10은 사용하지 않아요.</p><div class="z-buttons"><button class="z-btn z-btn--primary" data-action="download" data-file="kit">${icon("download", 16)}V4 설치 묶음 받기</button><button class="z-btn" data-action="download" data-file="sketch">스케치 전문</button><button class="z-btn" data-action="download" data-file="wiring">배선도</button><button class="z-btn" data-action="download" data-file="guide">설치 안내</button></div><ol class="z-install-list"><li>스케치 전문을 Arduino IDE에서 열고 보드를 Arduino Uno로 선택해 업로드해요.</li><li>시리얼 모니터와 기존 Python 중계를 닫은 뒤, 지원 브라우저에서 USB 연결을 눌러요.</li><li>실제 ADC·거리와 측정 오류를 확인해요. 초음파 NO ECHO는 출입이 아니에요.</li><li>감시 기준·허용 시간표를 적용하고, 이번 연결의 감시를 각각 시작해요.</li></ol><div class="z-callout">${icon("info")}<p>자동 경보와 실제 빛·소리는 직접 확인해야 해요. USB 단절 후 수동·출입 출력은 약 3초 안에 종료하도록 작성했지만, 보드 전원이 남으면 가스 자동 경보는 계속될 수 있어요.</p></div></section><section class="z-panel"><h2>기록 이전과 보관</h2><p class="z-description">현재 비밀번호·연결 키는 내보내지 않아요. 기존 기록은 삭제하지 않으며, 사용자가 선택한 자료만 가져와요. 같은 식별값의 기록은 덮어쓰지 않아요.</p><label class="z-field"><span>이전 집온 JSON · 2MB 이하, 최대 5,000건</span><input type="file" name="importFile" accept="application/json,.json"></label><label class="z-check z-check--wrap"><input type="checkbox" name="importSettings">자료에 포함된 설정도 가져오기 · 감시는 자동 시작하지 않아요.</label><div class="z-buttons"><button class="z-btn" data-action="import">이전 기록 가져오기</button><button class="z-btn" data-action="export">기록 내보내기</button></div></section><section class="z-panel"><h2>GitHub · Streamlit 실행</h2><p class="z-description">실행 파일은 <code>streamlit_app.py</code>예요. GitHub 저장소와 실행 파일을 Streamlit에서 선택하고, 가족 비밀번호와 영구 저장소 연결은 Streamlit의 Secrets에 설정해 주세요. 원본 V3 앱·중계는 별도로 보존돼요.</p><button class="z-btn" data-action="download" data-file="deployment">GitHub·Streamlit 안내 받기</button><p class="z-footnote">Streamlit의 로컬 파일은 영구 보관을 보장하지 않아요. 외부 저장소 연결 전에는 이번 접속의 임시 기록만 사용할 수 있어요. 새 앱에서 다른 컴퓨터의 USB를 원격 제어하지는 않아요.</p></section>`;
    this.updateLive();
  }
  updateLive() {
    if (!this.main) return;
    const saved = this.data.lastState;
    const remote = !this.usb?.port && saved?.sample && (!this.last || Date.parse(saved.last_seen) > (this.sampleWallTime || 0));
    // The transport announces freshness just before delivering its first sample.
    // Never enable controls or read sample fields during that empty-state handoff.
    const p = remote ? saved.sample : this.last, fresh = Boolean(!remote && p && this.usb?.fresh), canControl = fresh && this.lease && !this.commandBusy;
    const set = (key, value, tone) => { for (const node of this.root.querySelectorAll(`[data-live="${key}"]`)) { node.textContent = value; if (tone) node.className = `z-badge z-badge--${tone}`; } };
    const states = { disconnected: "연결 전", choosing: "포트 선택 중", opening: "연결 확인 중", waiting: "측정 대기", connected: "연결됨", stale: "측정 중단", error: "연결 오류" };
    set("connectionBadge", states[this.connection.state] || "연결 전", fresh ? "green" : ["stale", "error"].includes(this.connection.state) ? "red" : "muted"); set("connectionMessage", this.connection.message);
    if (remote) set("connectionMessage", "보관된 마지막 보고만 보여요. 제어하려면 이 컴퓨터에서 USB를 직접 연결해 주세요.");
    const gstate = fresh ? ({ disabled: "감시 꺼짐", below: "기준 아래", watch: "주의", alert: "위험 의심", fault: "측정 오류" }[p?.gasState] || "확인 중") : p ? "지난 측정" : "연결 전";
    set("gasState", gstate, fresh && p?.gasAlarm ? "red" : fresh && ["watch", "fault"].includes(p?.gasState) ? "amber" : fresh && p?.gasState === "below" ? "green" : "muted");
    set("gasValue", p?.gasRaw === null || p?.gasRaw === undefined ? "—" : p.gasRaw.toLocaleString("ko-KR"));
    set("gasNote", !fresh && p ? "지난 측정값이에요. 현재 상태는 확인되지 않았어요." : p?.gasRaw === 1023 ? "최대 출력이에요. 농도·가스 종류는 알 수 없어요." : p?.gasRaw === 0 ? "0 출력이에요. 정상·안전으로 판단하지 않아요." : "가스 농도가 아닌 원시 출력이에요.");
    set("gasAlarm", fresh ? p?.gasAlarm ? "위험 의심" : p?.gasState === "disabled" ? "감시 꺼짐" : p?.gasState === "fault" ? "측정 오류" : "경보 없음" : "현재 확인 안 됨");
    set("distanceValue", p?.distanceCm == null ? "—" : p.distanceCm.toLocaleString("ko-KR", { maximumFractionDigits: 1 }));
    set("distanceState", fresh ? p?.distanceCm == null ? "응답 없음" : "측정 중" : p ? "지난 측정" : "연결 전", fresh && p?.distanceCm == null ? "amber" : fresh ? "green" : "muted");
    set("distanceNote", !fresh && p ? "지난 측정값이에요. 현재 거리는 확인되지 않았어요." : p?.distanceCm === null ? "NO ECHO는 문 열림이나 출입이 아니에요." : "실제 사람의 출입을 확정하지 않아요.");
    set("intrusionState", !fresh ? "현재 확인 안 됨" : !this.intrusionArmed ? "감시 꺼짐" : !this.intrusionResult?.valid ? "측정 확인 필요" : this.intrusionResult.alarm ? "출입 의심" : this.intrusionResult.allowed ? "허용 시간" : this.intrusionResult.changed === null ? "첫 기준 확인 중" : "의심 경보 없음");
    for (const key of ["led", "buzzer"]) {
      const val = p ? p[key] ? key === "led" ? "켜짐" : "작동" : key === "led" ? "꺼짐" : "정지" : "확인 안 됨";
      set(`${key}Value`, fresh ? val : p ? `지난 보고 · ${val}` : val); set(`${key}Control`, fresh ? val : "현재 확인 안 됨"); set(`${key}Source`, p ? `${sourceName(p[`${key}Source`])}${fresh ? "" : " · 지난 보고"}` : "직접 연결 후 확인해요.");
      set(`${key}Manual`, p ? `마지막 보드 보고: 수동 요청 ${p[key === "led" ? "manualLed" : "manualBuzzer"] ? "유효" : "없음"}` : "수동 요청이 없어요.");
    }
    set("lastSeen", remote ? timeLabel(saved.last_seen) : this.sampleWallTime ? kstParts(this.sampleWallTime).clock : "아직 없어요"); set("commandNote", this.commandNote || "아직 요청하지 않았어요. 실행 응답과 마지막 출력 보고는 별개예요.");
    set("gasMonitoring", fresh ? p.gasState === "disabled" ? "꺼짐" : p.gasAlarm ? "경보 진행" : this.appliedGas?.rev === p.config ? "보드 감시 중" : "보드 감시 중 · 적용 기준 재확인" : "확인 안 됨"); set("intrusionMonitoring", this.intrusionArmed && fresh ? "이번 연결에서 사용" : "꺼짐");
    for (const b of this.root.querySelectorAll("[data-control]")) b.disabled = !canControl;
    for (const b of this.root.querySelectorAll('[data-action="gas-start"], [data-action="gas-stop"]')) b.disabled = !canControl || !gasReady(this.settings) || Boolean(p?.gasAlarm);
    const start = this.root.querySelector('[data-action="intrusion-start"]'); if (start) start.disabled = !canControl || !this.settings.intrusion.enabled || p?.distanceCm === null || this.intrusionArmed;
    const stop = this.root.querySelector('[data-action="intrusion-stop"]'); if (stop) stop.disabled = !canControl || !this.intrusionArmed;
    const isOpen = Boolean(this.usb?.port || this.usb?.opening);
    for (const b of this.root.querySelectorAll('[data-action="connect"]')) { b.hidden = isOpen; b.disabled = !navigator.serial || !globalThis.isSecureContext; }
    for (const b of this.root.querySelectorAll('[data-action="reconnect"]')) { b.hidden = isOpen || !this.usb?.savedPort; b.disabled = this.usb?.opening || false; }
    for (const b of this.root.querySelectorAll('[data-action="disconnect"]')) b.hidden = !isOpen;
    const alarm = this.root.querySelector("[data-alarm]");
    if (alarm) { alarm.hidden = !(fresh && (p?.gasAlarm || p?.intrusionAlarm)); alarm.textContent = p?.gasAlarm ? "화재·가스 위험 의심 · 설정한 원시 ADC 기준의 실습용 경보예요. 실제 상황을 직접 확인해 주세요." : "출입 의심 · 허용 시간 밖의 거리 변화예요. 사람의 출입이 확정된 것은 아니에요."; }
    const storageError = this.root.querySelector("[data-storage-error]");
    if (storageError) { storageError.hidden = !this.data.storageError; storageError.textContent = this.data.storageError || ""; }
    const sync = this.root.querySelector("[data-sync]");
    if (sync) { sync.hidden = !this.unsaved.length && !this.saveError && !this.droppedEvents; sync.textContent = this.droppedEvents ? `전송 대기가 한도를 넘어 ${this.droppedEvents}건을 보관하지 못했어요. ${this.unsaved.length}건 전송 대기 중이에요.` : this.saveError ? `${this.saveError} ${this.unsaved.length}건이 이 화면에서 전송을 기다려요. 화면을 닫기 전에 연결을 확인해 주세요.` : `${this.unsaved.length}건이 전송을 기다리고 있어요. 닫기 전에 저장 여부를 확인해 주세요.`; }
    const storage = this.root.querySelector("[data-storage]");
    if (!navigator.serial && storage && this.page === "monitor") { const desc = this.root.querySelector('[data-live="connectionMessage"]'); if (desc) desc.textContent = "이 브라우저는 USB 직접 연결을 지원하지 않아요. 데스크톱 Chrome·Edge에서 앱을 열어 주세요."; }
  }
  async destroy() {
    this.destroyed = true; clearInterval(this.timer); clearTimeout(this.toastTimer);
    if (this.pendingRequest) { clearTimeout(this.pendingRequest.timer); this.pendingRequest.reject(new Error("가족 공간이 닫혔어요.")); this.pendingRequest = null; }
    this.root.removeEventListener("click", this.onClick); this.root.removeEventListener("input", this.onChange); this.root.removeEventListener("change", this.onChange); this.root.removeEventListener("submit", this.onSubmit);
    document.removeEventListener("visibilitychange", this.onVisibility); window.removeEventListener("pagehide", this.onPageHide); window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.destroyCharts(); await this.usb.destroy();
  }
}
