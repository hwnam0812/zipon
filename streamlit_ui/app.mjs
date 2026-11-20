import { USB_PROTOCOL, MAX_POINTS, MAX_EVENTS, DEFAULT_SETTINGS, EVENT_TITLES, clone, kstParts, inWindows, validateSettings, gasReady, compareDoorDistance, boundedPush, eventRecord } from "./model.mjs";
import { DistanceAnalysis } from "./analysis.mjs";
import { UsbConnection } from "./serial.mjs";

export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z", monitor: "M3 12h4l3-8 4 16 3-8h4", history: "M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2",
  settings: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4", devices: "M12 3v12m-4-4 4 4 4-4M7 4h10v4H7zM6 20h12", usb: "M12 3v13m0-13-3 3m3-3 3 3M7 8v4l5 4m5-8v4l-5 4m-2 4a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  gas: "M12 3c2 4 6 5 6 10a6 6 0 0 1-12 0c0-3 2-6 6-10M12 12c-2 2-3 3-3 5", distance: "M5 4v16M19 4v16M8 12h8m-6-3-3 3 3 3m4-6 3 3-3 3", light: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 3H9z", sound: "M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14", arrow: "m9 5 7 7-7 7", check: "m5 12 4 4L19 6", x: "m6 6 12 12M6 18 18 6", lock: "M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3", info: "M12 8h.01M12 11v6M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0", download: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5", leaf: "M20 4C7 2 2 8 6 16c7 6 15-1 14-12M6 18 16 8", cable: "M7 3v4m4-4v4M5 7h8v3a4 4 0 0 1-8 0zM9 14v3a4 4 0 0 0 8 0v-4m-2 0h4V9h-4z",
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.info}"/></svg>`;
const navs = [["home", "홈"], ["history", "기록"], ["devices", "기기 관리"], ["quiet-time", "안심 시간"], ["settings", "설정"], ["monitor", "실시간"]];
const pageNames = { home: "우리 집", ...Object.fromEntries(navs), "gas-status": "가스 센서 상태", "door-status": "문 작동 확인" };
paths["quiet-time"] = "M12 8v5l3 2M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0";
paths.settings = "m10 3-1 3-3 1-2 3 2 2v3l3 2 3-1 3 1 3-2v-3l2-2-2-3-3-1-1-3zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0";
const days = ["일", "월", "화", "수", "목", "금", "토"];
const sourceName = s => ({ off: "꺼짐", manual: "수동 요청", gas: "가스 자동 경보", intrusion: "출입 의심" }[s] || "확인 안 됨");
const timeLabel = t => { try { const k = kstParts(Date.parse(t)); return `${k.date} ${k.clock}`; } catch { return "시각 확인 안 됨"; } };
const field = (name, label, value, attrs = "") => `<label class="z-field"><span>${label}</span><input name="${name}" autocomplete="off" value="${esc(value)}" ${attrs}></label>`;
const badge = (text, tone = "muted") => `<span class="z-badge z-badge--${tone}">${esc(text)}</span>`;
const pageLink = (page, label, section, className = "z-text-button") => `<a class="${className}" href="?page=${page}${section ? `&amp;section=${section}` : ""}" data-page="${page}"${section ? ` data-section="${section}"` : ""}>${esc(label)}</a>`;

export class ZiponApp {
  constructor(root, { Chart, data, emit }) {
    this.root = root; this.Chart = Chart; this.emit = emit; this.data = data;
    this.settings = clone(data.settings || DEFAULT_SETTINGS); this.draft = clone(this.settings); this.revision = data.settingsRevision || 0;
    this.draftRevision = this.revision;
    this.page = Object.hasOwn(pageNames, data.initialPage) ? data.initialPage : "home";
    const section = new URL(window.location.href).searchParams.get("section");
    this.setupSection = ["door", "gas"].includes(section) ? section : "basic";
    this.timeSection = section === "allowed" ? "allowed" : "quiet";
    this.points = []; this.localEvents = []; this.unsaved = []; this.acknowledged = new Set(); this.analysis = new DistanceAnalysis(); this.last = null;
    this.connection = { state: "disconnected", message: "USB 연결 전이에요.", fresh: false };
    this.intrusionArmed = false; this.intrusionResult = null; this.chartVisibility = { gas: true, distance: true }; this.charts = {};
    this.pendingRequest = null; this.requestTail = Promise.resolve(); this.lastBackend = performance.now(); this.commandBusy = false; this.backendBusy = false; this.lease = false;
    this.recordFilter = { day: "", kind: "all", offset: 0 }; this.recordResult = { rows: data.events || [], total: data.eventTotal || 0 }; this.isDirty = false; this.gasCommandRevision = 0;
    this.usb = new UsbConnection({ onSample: p => this.sample(p), onStatus: s => { this.connection = s; this.updateLive(); }, onEvent: (type, message) => this.usbEvent(type, message) });
    this.root.classList.add("z-app");
    this.root.innerHTML = `<a class="z-skip" href="#z-main">본문으로 이동</a><aside class="z-sidebar"><a class="z-brand" href="?page=home" data-page="home"><span>${icon("home", 26)}</span><b>집온</b><small>zipon</small></a><nav aria-label="주 메뉴">${this.navigation()}</nav><div class="z-sidebar-bottom"><button class="z-family" data-action="logout">${icon("lock")}<span><b>우리 가족</b><small>가족 공간 닫기</small></span>${icon("arrow", 16)}</button></div></aside><div class="z-workspace"><header class="z-topbar"><span class="z-crumb">${icon("home", 16)}<span data-home-name></span>${icon("arrow", 13)}<span data-page-name></span></span><a class="z-mobile-brand" href="?page=home" data-page="home">${icon("home", 22)}집온</a><button class="z-top-family" data-action="logout">${icon("lock", 13)}가족 공간</button></header><main id="z-main" tabindex="-1"></main><footer class="z-footer"><p>실습용 · 화재·누출·안전 판단 불가</p><details><summary>사용 시 주의</summary><p>인증된 독립 경보기를 대체하지 않아요. 실제 상황과 빛·소리는 현장에서 확인해 주세요. 앱을 닫거나 기기가 절전 중이면 알림과 기록이 빠질 수 있어요.</p></details></footer></div><nav class="z-mobile-nav" aria-label="모바일 주 메뉴">${this.navigation()}</nav><div class="z-toast" role="status" hidden></div><dialog class="z-dialog" aria-labelledby="z-dialog-title"><form method="dialog"><button class="z-dialog-x" value="cancel" aria-label="닫기">${icon("x")}</button><h2 id="z-dialog-title"></h2><p data-dialog-body></p><div class="z-dialog-actions"><button value="cancel" class="z-btn">취소</button><button value="apply" class="z-btn z-btn--primary" data-confirm-button>실행</button></div></form></dialog>`;
    this.main = this.root.querySelector("main");
    this.root.querySelector(".z-skip").dataset.action = "skip";
    this.onClick = event => { const button = event.target.closest("[data-action], [data-page]"); if (!button || !this.root.contains(button)) return; if (button.dataset.page) { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); this.navigate(button.dataset.page, button.dataset.section); } else if (!button.disabled) { if (button.dataset.action === "skip") event.preventDefault(); void this.action(button.dataset.action, button).catch(e => this.toast(e.message, true)); } };
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
  navigate(page, section) {
    const validSection = page === "settings" && ["basic", "door", "gas"].includes(section) || page === "quiet-time" && ["quiet", "allowed"].includes(section);
    const changedSection = validSection && section !== (page === "settings" ? this.setupSection : this.timeSection);
    if (!Object.hasOwn(pageNames, page) || page === this.page && !changedSection) return;
    if (this.savingSettings) { this.toast("설정을 저장하고 있어요. 잠시 뒤 이동해 주세요.", true); return; }
    if (this.isDirty && ["settings", "quiet-time"].includes(this.page)) { void this.confirm("수정한 내용을 버릴까요?", "저장한 설정은 그대로 남아요. 보드 감시는 바뀌지 않아요.", "수정 버리고 이동").then(ok => { if (ok) { this.resetDraft(); this.navigate(page, section); } }); return; }
    if (validSection) { if (page === "settings") this.setupSection = section; else this.timeSection = section; }
    this.page = page; this.render(); this.main.focus({ preventScroll: true }); this.root.scrollIntoView({ block: "start" });
    if (page === "history") void this.loadRecords();
  }
  update(data, emit) {
    this.emit = emit; if (this.data.serverTime !== data.serverTime) this.lastBackend = performance.now(); this.data = data;
    if (data.storageError && this.usb?.port) { this.lease = false; this.intrusionArmed = false; this.usb.intrusion = false; void this.usb.close("보관 연결을 확인하지 못해 직접 제어를 종료했어요. 보드 가스 자동 경보는 별개예요."); }
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
      if (!this.isDirty) { this.draft = clone(this.settings); this.draftRevision = this.revision; if (["settings", "quiet-time", "home"].includes(this.page)) this.render(); }
      else if (!ownSettingsReply) this.toast("다른 화면에서 설정이 바뀌었어요. 저장 전에 다시 불러와 주세요.", true);
    }
    this.updateLive(); this.renderEvents();
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
    const faults = { gas: p.gasRaw === null || p.gasRaw === 0 || p.gasRaw === 1023 || p.gasState === "fault", distance: p.distanceCm === null };
    for (const key of ["gas", "distance"]) {
      if (faults[key] && !this.faults?.[key]) this.event("sensor_error", key === "gas" ? "가스 원시 출력이 없거나 0·1023 끝값이에요. 전원·AO 배선·센서를 확인해 주세요. 정상·안전 판정이 아니에요." : "초음파 응답이 없어요. 문 열림이나 사람의 출입으로 판정하지 않아요.");
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
    if (action === "reset-settings") { this.resetDraft(); this.renderSettingsPage(); return; }
    if (action === "reload-settings") { if (this.isDirty && !await this.confirm("수정한 설정을 버릴까요?", "마지막으로 저장한 설정을 다시 불러와요.", "다시 불러오기")) return; const r = await this.request("refresh"); this.settings = clone(r.settings); this.revision = r.settingsRevision; this.resetDraft(); this.render(); return; }
    if (action === "use-distance" || action === "use-gas") {
      if (!this.usb.fresh || !this.last) throw new Error("새 측정값을 받은 뒤 사용해 주세요.");
      if (action === "use-distance") { if (this.last.distanceCm == null || this.last.distanceCm > 390) return; this.draft.intrusion.baselineCm = this.last.distanceCm; this.draft.intrusion.baselineConfirmed = false; }
      else { if (!(this.last.gasRaw > 0 && this.last.gasRaw < 1023)) return; this.draft.gas.baseline = this.last.gasRaw; this.draft.gas.warmupConfirmed = false; }
      this.markDirty(); this.renderSettingsPage(); return;
    }
    if (action === "retry-save") { await this.flush(); return; }
    if (action === "notification") {
      if (this.browserNotifications) { this.browserNotifications = false; this.updateLive(); this.toast("브라우저 알림을 껐어요."); return; }
      if (!("Notification" in window)) throw new Error("이 브라우저는 직접 알림을 지원하지 않아요. 화면 안 기록은 계속 볼 수 있어요.");
      this.browserNotifications = await Notification.requestPermission() === "granted"; this.updateLive(); this.toast(this.browserNotifications ? "이 화면을 열어 둔 동안 브라우저 알림을 사용해요." : "브라우저 알림이 허용되지 않았어요."); return;
    }
    if (action === "gas-start" || action === "gas-stop") {
      if (!this.usb.fresh || !this.lease) throw new Error("USB를 연결하고 새 측정값을 받은 뒤 시작해 주세요.");
      if (!gasReady(this.settings)) throw new Error("설정에서 예열·기준값을 직접 확인하고 가스 기준을 먼저 적용해 주세요.");
      if (this.last.gasAlarm) throw new Error("가스 출력 경보가 진행 중이에요. 수동 끄기로 해제하지 않아요.");
      if (!await this.confirm(action === "gas-start" ? "이번 연결에서 가스 감시를 시작할까요?" : "가스 감시를 종료할까요?", action === "gas-start" ? "설정한 원시 ADC 기준의 실습용 감시예요. 센서 예열과 실제 환경을 직접 확인했는지 다시 살펴봐 주세요." : "가스 출력에 따른 자동 경보가 더 이상 시작되지 않아요. 인증 경보기의 동작과는 관계없어요.", action === "gas-start" ? "가스 감시 시작" : "가스 감시 종료")) return;
      const g = this.settings.gas;
      const rev = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
      await this.boardCommand("config", { gasEnabled: action === "gas-start", gasThreshold: g.threshold, gasRecovery: g.recovery, gasHoldMs: g.holdSeconds * 1000, gasRecoveryMs: g.recoverySeconds * 1000, rev }, "가스 감시 설정"); return;
    }
    if (action === "intrusion-start") {
      if (!this.usb.fresh || !this.lease || this.last?.distanceCm === null) throw new Error("USB 연결과 실제 초음파 측정값을 먼저 확인해 주세요.");
      if (!this.settings.intrusion.enabled) throw new Error("설정에서 출입 감시 사용과 허용 시간표를 먼저 적용해 주세요.");
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
      list.push({ id: crypto.randomUUID(), name: key === "quietWindows" ? "새 안심 시간" : "새 허용 시간", enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] }); this.markDirty(); this.renderSettingsPage(); const name = this.root.querySelector(`[name="window.${key === "quietWindows" ? "quiet" : "allowed"}.${list.length - 1}.name"]`); name?.focus(); return;
    }
    if (action === "remove-window") {
      const key = button.dataset.group, index = Number(button.dataset.index), list = key === "quiet" ? this.draft.quietWindows : this.draft.intrusion.allowedWindows;
      const [row] = list.splice(index, 1); this.undoWindow = { key, index, row }; this.markDirty(); this.renderSettingsPage(); return;
    }
    if (action === "undo-window") { if (this.undoWindow) { const u = this.undoWindow, list = u.key === "quiet" ? this.draft.quietWindows : this.draft.intrusion.allowedWindows; if (list.length < 20) list.splice(u.index, 0, u.row); this.undoWindow = null; this.markDirty(); this.renderSettingsPage(); } return; }
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
    if (this.data.storageError || !(this.data.durable || this.data.mode === "development")) throw new Error("보관 연결을 확인하지 못했어요. 연결을 복구한 뒤 다시 제어해 주세요.");
    if (this.commandBusy || !this.usb.fresh || !this.lease) throw new Error("USB 연결과 새 측정값·이전 요청 응답을 확인해 주세요.");
    this.commandBusy = true; this.event("command_requested", description); this.updateLive();
    try { const reply = await this.usb.command(type, fields); if (type === "config") this.appliedGas = clone(fields); this.event("command_applied", `${description} · 요청 ${reply.id}. 실제 빛·소리는 직접 확인해야 해요.`); this.commandNote = `${description}: 보드 실행 응답을 받았어요. 마지막 출력 보고와는 별개예요.`; this.toast("보드 실행 응답을 받았어요. 현재 출력 보고를 기다려 주세요."); }
    catch (e) { this.event(e.message.includes("응답이 없") ? "command_expired" : "command_rejected", `${description} · ${e.message}`); this.commandNote = e.message; throw e; }
    finally { this.commandBusy = false; this.updateLive(); }
  }
  async saveSettings() {
    if (this.savingSettings || !this.isDirty) return;
    const settings = validateSettings(this.draft);
    if (this.last?.gasAlarm) {
      if (JSON.stringify(settings.gas) !== JSON.stringify(this.settings.gas)) throw new Error("가스 경보 중에는 가스 기준을 바꾸지 않아요.");
    }
    this.savingSettings = true;
    const fields = this.root.querySelector("[data-settings-fields]"); if (fields) fields.disabled = true;
    const submit = this.root.querySelector('[data-settings-form] button[type="submit"]'); if (submit) { submit.disabled = true; submit.textContent = "적용 중…"; }
    let r;
    try { r = await this.request("settings", { settings, revision: this.draftRevision }); }
    finally { this.savingSettings = false; if (fields) fields.disabled = false; if (submit) { submit.disabled = false; submit.textContent = this.data.durable ? "설정 저장" : "이번 접속에 적용"; } }
    this.settings = clone(r.settings); this.draft = clone(r.settings); this.revision = this.draftRevision = r.settingsRevision; this.isDirty = false; this.undoWindow = null;
    this.analysis.reset(); this.intrusionArmed = false; this.usb.intrusion = false; this.intrusionResult = null;
    this.event("settings_saved", "설정을 적용했어요. 가스 기준은 USB에서 감시 시작을 눌러 보드에 적용해야 해요. 출입 감시는 다시 시작해 주세요.");
    this.toast(r.persistent ? "설정을 저장했어요. 보드 감시는 별도로 시작해 주세요." : "이번 접속에만 적용했어요. 영구 저장은 준비되지 않았어요."); this.render();
  }
  resetDraft() { this.draft = clone(this.settings); this.draftRevision = this.revision; this.isDirty = false; this.undoWindow = null; }
  markDirty() {
    this.isDirty = JSON.stringify(this.draft) !== JSON.stringify(this.settings);
    const note = this.root.querySelector("[data-dirty]"); if (note) note.textContent = this.isDirty ? "수정 중" : "저장한 설정";
    for (const b of this.root.querySelectorAll('[data-settings-form] button[type="submit"], [data-action="reset-settings"]')) b.disabled = !this.isDirty || this.savingSettings;
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
    if (input.name === "intrusion.baselineCm") {
      this.draft.intrusion.baselineConfirmed = false;
      const check = this.root.querySelector('[name="intrusion.baselineConfirmed"]'); if (check) check.checked = false;
    }
    this.markDirty();
  }
  async loadRecords() {
    const version = this.recordsVersion = (this.recordsVersion || 0) + 1;
    this.recordsLoading = true; this.updateRecordsView();
    try { const result = await this.request("events", { ...this.recordFilter }); if (version === this.recordsVersion) { this.recordResult = result; this.recordsError = ""; } }
    catch (e) { if (version === this.recordsVersion) this.recordsError = e.message; }
    finally { if (version === this.recordsVersion) { this.recordsLoading = false; this.updateRecordsView(); } }
  }
  updateRecordsView() {
    if (this.page !== "history") return;
    const results = this.root.querySelector("[data-record-results]");
    if (results) { results.innerHTML = this.historyResults(); results.setAttribute("aria-busy", String(Boolean(this.recordsLoading))); }
  }
  download(content, name, mime) { const blob = new Blob([content], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; this.root.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  render() {
    const url = new URL(window.location.href); url.searchParams.set("page", this.page); if (this.page === "settings" || this.page === "quiet-time") url.searchParams.set("section", this.page === "settings" ? this.setupSection : this.timeSection); else url.searchParams.delete("section"); window.history.replaceState(null, "", url);
    for (const a of this.root.querySelectorAll("[data-page]")) a.dataset.page === this.page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
    this.root.querySelector("[data-home-name]").textContent = this.settings.homeName;
    this.root.querySelector("[data-page-name]").textContent = pageNames[this.page] || "우리 집";
    this.destroyCharts();
    if (this.page === "monitor") this.renderMonitor(); else if (this.page === "settings" || this.page === "quiet-time") this.renderSettingsPage(); else if (this.page === "history") this.renderHistory(); else if (this.page === "devices") this.renderDevices(); else if (this.page === "gas-status") this.renderGasStatus(); else if (this.page === "door-status") this.renderDoorStatus(); else this.renderHome();
    this.updateLive(); this.renderEvents();
  }
  heading(title, description = "") { return `<div class="z-heading"><h1>${title}</h1>${description ? `<span>${description}</span>` : ""}</div>${this.storageNotice()}<div class="z-sync-note" data-storage-error role="status" hidden></div>`; }
  storageNotice() {
    return `<div class="z-storage-note ${this.data.durable ? "z-storage-note--ok" : ""}" data-storage role="status">${icon(this.data.durable ? "check" : "info", 15)}<span>${this.data.durable ? "기록 보관 연결됨" : this.data.mode === "development" ? "개발 확인용 임시 저장 · 실제 가족 기록이 아니에요." : "보관 연결을 확인하지 못했어요. 저장과 새 제어를 사용할 수 없어요."}</span></div><div class="z-sync-note" data-sync role="status" hidden></div>`;
  }
  connectionCard() {
    return `<section class="z-connect"><span class="z-connect-icon">${icon("usb", 28)}</span><div><div class="z-connect-title"><h2>우리 집 UNO</h2><span data-live="connectionBadge" class="z-badge z-badge--muted">연결 전</span></div><p data-live="connectionMessage">USB 연결 전이에요.</p><small>USB 직접 연결 · V4 · 9600 baud</small></div><div class="z-connect-actions"><button class="z-btn z-btn--primary" data-action="connect">${icon("usb", 17)}USB 연결</button><button class="z-btn" data-action="reconnect" hidden>다시 연결</button><button class="z-btn" data-action="disconnect" hidden>연결 해제</button></div></section>`;
  }
  connectionSummary() {
    return `<section class="z-connection-summary" aria-label="USB 연결 상태"><div>${icon("usb", 19)}<b>USB 직접 연결</b><span data-live="connectionBadge" class="z-badge z-badge--muted">연결 전</span><span>마지막 수신 <b data-live="lastSeen">아직 없어요</b></span></div>${pageLink("devices", "연결 관리")}<p data-live="connectionMessage">USB 연결 전이에요.</p></section>`;
  }
  metrics() {
    return `<div class="z-metrics"><section class="z-sensor"><div class="z-sensor-title"><span>${icon("gas")}가스 센서</span><span class="z-badge z-badge--muted" data-live="gasState">연결 전</span></div><p class="z-number"><b data-live="gasValue">—</b><span>ADC</span></p><p class="z-sensor-note" data-live="gasNote">가스 농도가 아닌 원시 출력이에요.</p><div class="z-sensor-bottom"><span>원시 출력 감시</span><strong data-live="gasAlarm">현재 확인 안 됨</strong></div><a class="z-text-button" href="?page=gas-status" data-page="gas-status">가스 센서 상태 보기</a></section>
      <section class="z-sensor"><div class="z-sensor-title"><span>${icon("distance")}초음파 센서</span><span class="z-badge z-badge--muted" data-live="distanceState">연결 전</span></div><p class="z-number"><b data-live="distanceValue">—</b><span>cm</span></p><p class="z-sensor-note" data-live="distanceNote">실제 사람의 출입을 확정하지 않아요.</p><div class="z-sensor-bottom"><span>출입 의심</span><strong data-live="intrusionState">감시 꺼짐</strong></div><a class="z-text-button" href="?page=door-status" data-page="door-status">문 작동 확인 보기</a></section></div>
      <div class="z-output-summary"><div>${icon("light")}<span>LED 마지막 보고</span><b data-live="ledValue">확인 안 됨</b><small data-live="ledSource">직접 연결 후 확인해요.</small></div><div>${icon("sound")}<span>부저 마지막 보고</span><b data-live="buzzerValue">확인 안 됨</b><small data-live="buzzerSource">직접 연결 후 확인해요.</small></div><div>${icon("history")}<span>마지막 측정</span><b data-live="lastSeen">아직 없어요</b><small>요청이나 응답 시각과 달라요.</small></div></div><div class="z-alarm" role="alert" data-alarm hidden></div>`;
  }
  advancedControls() {
    return `<details class="z-control-details z-help"><summary>상세 제어·요청 상태</summary><div class="z-control-grid">${[["led", "LED", "light"], ["buzzer", "부저", "sound"]].map(([target, label, symbol]) => `<div class="z-control-unit"><h3>${icon(symbol)}${label}</h3><div class="z-buttons">${target === "led" ? '<button class="z-btn" data-action="manual-led-test" data-control disabled>LED 2초 시험</button>' : '<button class="z-btn" data-action="manual-buzzer-on" data-control disabled>부저 15초 켜기</button>'}</div><small data-live="${target}Manual">수동 요청이 없어요.</small></div>`).join("")}</div><p class="z-footnote">출력 우선순위는 가스, 출입 의심, 수동 요청 순서예요. 수동 끄기는 자동 경보를 멈추지 않아요.</p></details>`;
  }
  monitoringControls() {
    return `<section class="z-panel z-arm-panel"><div><h2>이번 연결의 감시</h2><p>기준 저장과 감시 시작은 별개예요.</p></div><div class="z-arm-row"><span>가스 출력 감시 <b data-live="gasMonitoring">꺼짐</b></span><div class="z-buttons"><button class="z-btn" data-action="gas-start" data-control disabled>가스 감시 시작</button><button class="z-btn" data-action="gas-stop" data-control disabled>가스 감시 종료</button>${pageLink("settings", "기준 확인", "gas")}</div></div><div class="z-arm-row"><span>출입 의심 감시 <b data-live="intrusionMonitoring">꺼짐</b></span><div class="z-buttons"><button class="z-btn" data-action="intrusion-start" data-control disabled>출입 감시 시작</button><button class="z-btn" data-action="intrusion-stop" data-control disabled>출입 감시 종료</button>${pageLink("quiet-time", "허용 시간", "allowed")}</div></div><details class="z-help"><summary>감시 도움말</summary><p class="z-footnote">설정에서 가스 예열·기준과 출입 감시 사용을 먼저 확인해 주세요. 화면을 숨기면 출입 감시는 종료돼요. 보드 전원이 남으면 USB가 끊겨도 가스 자체 감시는 계속될 수 있어요.</p></details><p class="z-command-note" data-live="commandNote">실행 응답과 현재 출력 보고는 별개예요.</p></section>`;
  }
  quickControls() {
    return `<section class="z-panel z-quick-controls" aria-label="우리 집 바로 제어">
      <div class="z-section-head"><h2>우리 집 바로 제어</h2></div>
      <div class="z-quick-actions">
        <button class="z-quick-button" data-action="manual-led-on" data-control disabled>${icon("light", 25)}<span><b>LED 켜기</b><small>15초 뒤 수동 요청 종료</small></span></button>
        <button class="z-quick-button z-quick-button--sound" data-action="manual-buzzer-test" data-control disabled>${icon("sound", 25)}<span><b>부저 울리기</b><small>재확인 후 2초 시험</small></span></button>
      </div>
      <div class="z-quick-report"><span>마지막 출력 보고</span><b>LED <span data-live="ledControl">확인 안 됨</span> · 부저 <span data-live="buzzerControl">확인 안 됨</span></b></div>
      <div class="z-buttons z-quick-stop"><button class="z-btn" data-action="manual-led-off" data-control disabled>수동 LED 끄기</button><button class="z-btn" data-action="manual-buzzer-off" data-control disabled>수동 부저 끄기</button></div>
      <p class="z-footnote">실제 빛·소리는 현장에서 확인해 주세요. 수동 끄기는 자동 경보를 멈추지 않아요.</p>${this.advancedControls()}<p class="z-command-note" data-live="commandNote">실행 응답과 현재 출력 보고는 별개예요.</p>
    </section>`;
  }
  statusOverview() {
    return `<div class="z-status-overview">
      <a class="z-panel z-status-card" href="?page=gas-status" data-page="gas-status" aria-label="가스 센서 상태 상세 보기"><div class="z-status-heading">${icon("gas")}<h2>가스 센서 상태</h2>${icon("arrow", 16)}</div><div class="z-status-result"><span>화재 위험</span><strong>판단 불가</strong><small data-live="gasComparisonNote">농도 미측정</small></div><div class="z-status-reading"><span>현재 원시값</span><b><span data-live="currentGas">—</span><small>ADC</small></b></div><p>5,000ppm 기준 미적용 · 실제 농도로 환산하지 않아요.</p><div class="z-status-link">센서와 기준 살펴보기 ${icon("arrow", 15)}</div></a>
      <a class="z-panel z-status-card" href="?page=door-status" data-page="door-status" aria-label="문 작동 확인 상세 보기"><div class="z-status-heading">${icon("distance")}<h2>문 작동 확인</h2>${icon("arrow", 16)}</div><div class="z-status-result"><span>닫힘 기준 ±10cm 비교</span><strong data-live="doorComparison">확인 불가</strong><small>화면 비교용</small></div><div class="z-status-reading"><span>현재 거리</span><b><span data-live="currentDistance">—</span><small>cm</small></b></div><p>거리 변화 표시예요. 문 열림·실제 출입을 확정하지 않아요.</p><div class="z-status-link">거리와 기준 살펴보기 ${icon("arrow", 15)}</div></a>
    </div>`;
  }
  renderGasStatus() {
    this.main.innerHTML = this.heading("가스 센서 상태", "측정한 원시값과 판단할 수 없는 위험도를 구분해요.") + `<a class="z-text-button z-back-home" href="?page=home" data-page="home">우리 집으로</a><div class="z-status-detail">
      <section class="z-panel z-status-primary">${icon("gas", 30)}<p class="z-status-kicker">화재 위험</p><h2>판단 불가</h2><p class="z-status-explanation">농도 미측정 · 화재 위험 판단 불가<br>원시 출력만으로 화재·누출·안전을 판단할 수 없어요.</p><div class="z-threshold"><span>요청한 비교 기준</span><b>5,000 <small>ppm 초과</small></b>${badge("미적용", "amber")}<p>ppm 환산과 가스별 보정이 없어 이 기준과 비교하지 않아요. 검증된 화재 기준으로 제시하지 않아요.</p></div></section>
      <div><section class="z-panel z-measurement"><div class="z-section-head"><h2>실제로 받은 값</h2><span class="z-badge" data-live="gasState">연결 전</span></div><p class="z-detail-number"><b data-live="currentGas">—</b><span>ADC</span></p><progress data-raw-range value="0" max="1023" aria-label="가스 원시 출력 0에서 1023. 위험도 게이지가 아니에요."></progress><div class="z-measurement-scale"><span>0 ADC</span><span>1023 ADC</span></div><dl class="z-measurement-facts"><div><dt>근사 전압</dt><dd data-live="gasVoltage">확인 불가</dd></div><div><dt>원시 출력 감시</dt><dd data-live="gasAlarm">현재 확인 안 됨</dd></div><div><dt>마지막 측정</dt><dd data-live="lastSeen">아직 없어요</dd></div></dl><p class="z-footnote" data-live="gasNote">가스 농도가 아닌 원시 출력이에요.</p></section><section class="z-status-help"><h2>출력 경고와 화재 판단은 달라요</h2><p>기존 ADC 감시와 보드 자동 반응은 그대로예요. 값이 낮거나 측정에 실패해도 안전하다는 뜻은 아니에요.</p>${pageLink("settings", "기존 감시 기준 보기", "gas")}</section></div>
      </div><section class="z-panel"><h2>센서 전원·배선 점검</h2><p class="z-description">가열되지 않거나 1023이 계속되면 측정이 정상이라고 볼 수 없어요. 전원을 모두 끄고 VCC·공통 GND·AO A5를 확인해 주세요. 센서의 열을 손으로 확인하거나 가스를 방출해 시험하지 마세요.</p>${pageLink("devices", "기기 점검 안내", undefined, "z-btn")}</section><div class="z-alarm" role="alert" data-alarm hidden></div>${this.detailTimeline("gas")}`;
    this.createCharts(); this.updateCharts();
  }
  renderDoorStatus() {
    this.main.innerHTML = this.heading("문 작동 확인", "실제로 확인한 닫힘 거리에서 얼마나 달라졌는지 살펴봐요.") + `<a class="z-text-button z-back-home" href="?page=home" data-page="home">우리 집으로</a><div class="z-status-detail">
      <section class="z-panel z-status-primary" data-door-comparison>${icon("distance", 30)}<p class="z-status-kicker">닫힘 기준과 비교한 현재 거리</p><h2 data-live="doorComparison">확인 불가</h2><p class="z-status-explanation" data-live="doorReason">새 측정과 확인한 닫힘 기준이 필요해요.</p><div class="z-distance-ruler" aria-hidden="true"><span>−10cm</span><span>닫힘 기준</span><span>+10cm</span></div><p class="z-footnote">화면 비교용이에요. 실제 문 열림·출입을 확정하거나 기존 자동 감지의 기준을 바꾸지 않아요.</p></section>
      <div><section class="z-panel z-measurement"><h2>거리 비교</h2><dl class="z-distance-readings"><div><dt>현재 거리</dt><dd><b data-live="currentDistance">—</b><small>cm</small></dd></div><div><dt>확인한 닫힘 기준</dt><dd><b data-live="doorBaseline">—</b><small>cm</small></dd></div><div><dt>기준과의 차이</dt><dd><b data-live="doorDelta">—</b><small>cm</small></dd></div></dl><p class="z-footnote">기본 입력값은 직접 확인한 기준으로 사용하지 않아요. 기존 감시의 변화량·지속 설정은 그대로예요.</p>${pageLink("settings", "닫힘 기준 확인·보정", "door", "z-btn")}</section><section class="z-status-help"><h2>무응답은 문 작동이 아니에요</h2><p>Trig D9 · Echo D8 연결과 새 V4 통합 코드를 확인해 주세요. 핀 변경만으로 센서가 정상 작동한다고 보장하지 않아요.</p>${pageLink("devices", "연결·배선 안내 보기")}</section></div>
      </div>${this.detailTimeline("distance")}`;
    this.createCharts(); this.updateCharts();
  }
  detailTimeline(key) {
    return `<section class="z-chart-section"><div class="z-section-head"><div><h2>최근 측정 변화</h2><p>이번 접속의 최근 600개예요. 오류·수신 중단은 선을 연결하지 않아요.</p></div><button class="z-text-button" data-page="monitor">모든 측정값 보기</button></div>${this.chartCard(key, key === "gas" ? "가스 원시 출력 변화" : "거리 변화", "화재·실제 출입을 판단하지 않아요.")}<details class="z-data-table"><summary>최근 측정 10개를 표로 보기</summary><div data-sample-table></div></details></section><section class="z-panel"><div class="z-section-head"><h2>관련 최근 기록</h2><button class="z-text-button" data-page="history">전체 기록</button></div><div data-events data-events-kind="${key}"></div></section>`;
  }
  renderHome() {
    this.main.innerHTML = this.heading("우리 집 한눈에") + this.connectionSummary() + `<div class="z-alarm" role="alert" data-alarm hidden></div><div class="z-home-main">${this.statusOverview()}${this.quickControls()}</div><div class="z-home-bottom">
      <section class="z-panel"><div class="z-section-head"><h2>최근 기록</h2>${pageLink("history", "전체 기록")}</div><div data-events></div></section>
      <section class="z-panel"><div class="z-section-head"><h2>안심 시간</h2>${badge(this.settings.quietEnabled ? `${this.settings.quietWindows.filter(w => w.enabled).length}개 사용` : "꺼짐")}</div>${this.settings.quietEnabled && this.settings.quietWindows.some(w => w.enabled) ? this.settings.quietWindows.filter(w => w.enabled).slice(0, 2).map(w => `<div class="z-quiet-summary"><b>${esc(w.name)}</b><span>${esc(w.start)}–${esc(w.end)}${w.start > w.end ? " · 다음 날" : ""}</span><small>${w.days.length === 7 ? "매일" : w.days.map(d => days[d]).join("·")}</small></div>`).join("") : `<p class="z-empty-small">사용 중인 안심 시간이 없어요.</p>`}${pageLink("quiet-time", "시간 관리")}</section></div>`;
    this.renderEvents();
  }
  renderMonitor() {
    this.destroyCharts();
    this.main.innerHTML = this.heading("실시간 측정값") + this.connectionSummary() + this.metrics() + `<section class="z-chart-section"><div class="z-section-head"><div><h2>시간에 따른 변화</h2><p>최근 600개 · 새로고침하면 다시 시작해요.</p></div><div class="z-chart-toggles"><button class="z-btn z-btn--small" data-action="graph-gas" aria-pressed="${this.chartVisibility.gas}">${icon("gas", 15)}가스 그래프</button><button class="z-btn z-btn--small" data-action="graph-distance" aria-pressed="${this.chartVisibility.distance}">${icon("distance", 15)}거리 그래프</button><button class="z-text-button" data-action="clear-graph">그래프 비우기</button></div></div><div class="z-charts">${this.chartVisibility.gas ? this.chartCard("gas", "가스 센서 변화", "원시 ADC · 농도 환산 없음") : ""}${this.chartVisibility.distance ? this.chartCard("distance", "초음파 거리 변화", "cm · 실제 출입 확정 아님") : ""}</div>${!this.chartVisibility.gas && !this.chartVisibility.distance ? `<div class="z-empty">보고 싶은 센서의 그래프를 켜 주세요.</div>` : ""}<details class="z-data-table"><summary>최근 측정 10개를 표로 보기</summary><div data-sample-table></div></details></section>`;
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
      const threshold = key === "gas" ? gasReady(this.settings) ? this.settings.gas.threshold : null : this.settings.intrusion.baselineConfirmed === true ? this.settings.intrusion.baselineCm : null;
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
  renderSettingsPage() {
    if (this.page === "quiet-time") this.renderQuietTime(); else this.renderSettings();
    this.updateLive();
  }
  settingsFooter() {
    return `<div class="z-settings-save"><span data-dirty role="status">${this.isDirty ? "수정 중" : "저장한 설정"}</span>${this.undoWindow ? '<button type="button" class="z-text-button" data-action="undo-window">시간 삭제 되돌리기</button>' : ""}<button type="button" class="z-btn" data-action="reset-settings" ${this.isDirty ? "" : "disabled"}>수정 취소</button><button type="submit" class="z-btn z-btn--primary" ${this.isDirty ? "" : "disabled"}>${this.data.durable ? "설정 저장" : "이번 접속에 적용"}</button></div>`;
  }
  sectionNavigation(page, active, sections) {
    return `<nav class="z-settings-tabs" aria-label="${page === "settings" ? "설정 항목" : "시간표 항목"}">${sections.map(([id, label]) => `<a href="?page=${page}&section=${id}" data-page="${page}" data-section="${id}" ${active === id ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  }
  renderQuietTime() {
    const s = this.draft, quiet = this.timeSection === "quiet", list = quiet ? s.quietWindows : s.intrusion.allowedWindows;
    this.main.innerHTML = this.heading("안심 시간", "한국 시간 기준이에요.") + this.sectionNavigation("quiet-time", this.timeSection, [["quiet", "문 알림 시간"], ["allowed", "출입 허용 시간"]]) + `<form class="z-settings-content" data-settings-form novalidate><fieldset data-settings-fields><legend class="z-sr-only">시간표 설정</legend><section class="z-panel"><div class="z-section-head"><div><h2>${quiet ? "문 알림 시간" : "출입 허용 시간"}</h2><p>${quiet ? "이 시간의 거리 변화는 앱 알림을 남겨요. 보드 출력 시간표는 아니에요." : "이 시간에는 출입 의심 경보를 요청하지 않아요. 문 알림 시간과는 달라요."}</p></div>${quiet ? `<label class="z-check"><input type="checkbox" name="quietEnabled" ${s.quietEnabled ? "checked" : ""}>안심 시간 사용</label>` : ""}</div>
      ${this.windowEditor(quiet ? "quiet" : "allowed", list)}<div class="z-window-add"><button type="button" class="z-btn" data-action="add-${quiet ? "quiet" : "allowed"}" ${list.length >= 20 ? "disabled" : ""}>+ ${quiet ? "안심" : "허용"} 시간 추가</button><span>${list.length} / 20개</span></div><details class="z-help"><summary>시간표 도움말</summary><p class="z-footnote">자정을 넘으면 시작 요일을 따라요. 겹친 시간도 같은 거리 변화에는 한 번만 알림을 남겨요. 개별 사용을 끄거나 삭제한 뒤 저장하면 적용돼요.${quiet ? "" : " 처음 기준 거리 안쪽을 확인한 뒤 감지해요. 오류 후 첫 복구값은 출입으로 세지 않아요."}</p></details></section>${this.settingsFooter()}</fieldset></form>`;
  }
  renderSettings() {
    const s = this.draft, g = s.gas, i = s.intrusion;
    const numberField = (name, label, value, min, max, step = 1) => field(name, name === "gas.recoverySeconds" ? "가스 복귀 지속 확인(초)" : label, value, `type="number" min="${min}" max="${max}" step="${step}"`);
    const currentReading = `<div class="z-calibration-reading"><span>현재 ${this.setupSection === "door" ? '거리 <b data-live="currentDistance">—</b> cm' : '원시값 <b data-live="currentGas">—</b> ADC'}</span><button type="button" class="z-btn" data-action="${this.setupSection === "door" ? "use-distance" : "use-gas"}" disabled>현재 값 넣기</button></div>`;
    let content;
    if (this.setupSection === "basic") content = `<section class="z-panel"><h2>기본 설정</h2>${field("homeName", "집 이름 *", s.homeName, 'maxlength="20" required')}<div class="z-notification-setting"><div><h3>이 기기 브라우저 알림</h3><p>화면을 열어 둔 동안만 받아요.</p></div><button type="button" class="z-btn" data-action="notification" aria-pressed="false">알림 켜기</button></div><p class="z-footnote" data-live="notificationStatus"></p></section>`;
    else if (this.setupSection === "door") content = `<section class="z-panel" id="z-door-settings"><div class="z-section-head"><div><h2>문 기준 확인</h2><p>문을 닫고 기준 거리를 직접 확인해 주세요.</p></div></div>${currentReading}${numberField("intrusion.baselineCm", "기준 거리(cm)", i.baselineCm, 2, 390, .1)}<label class="z-check z-check--wrap"><input type="checkbox" name="intrusion.baselineConfirmed" ${i.baselineConfirmed === true ? "checked" : ""}>실제로 문을 닫고 위 기준 거리를 직접 확인했어요.</label><details class="z-help"><summary>고급 설정</summary><label class="z-check"><input type="checkbox" name="intrusion.enabled" ${i.enabled ? "checked" : ""}>출입 감시 사용</label><div class="z-form-grid">${numberField("intrusion.deltaCm", "최소 변화량(cm)", i.deltaCm, 2, 100, .1)}${numberField("intrusion.holdSeconds", "변화 지속 확인(초)", i.holdSeconds, 1, 30)}${numberField("intrusion.recoverySeconds", "복귀 지속 확인(초)", i.recoverySeconds, 1, 30)}${numberField("intrusion.cooldownSeconds", "반복 방지 시간(초)", i.cooldownSeconds, 5, 600)}</div><p class="z-footnote">문 상세의 ±10cm는 화면 비교용이에요. 위 자동 감시 기준과는 별개예요.</p></details><p class="z-footnote">저장 후 기기 관리에서 출입 감시를 따로 시작해요.</p></section>`;
    else content = `<section class="z-panel"><div class="z-section-head"><div><h2>가스 기준 확인</h2><p>예열과 안정된 원시 출력을 직접 확인해 주세요.</p></div></div><p class="z-caution">실습용 ADC 기준이에요. 화재·누출을 판단하지 않아요.</p>${currentReading}${numberField("gas.baseline", "직접 확인한 기준 ADC", g.baseline, 1, 1022)}<label class="z-check z-check--wrap"><input type="checkbox" name="gas.warmupConfirmed" ${g.warmupConfirmed ? "checked" : ""}>제조사 안내에 따른 예열과 실제 기준 출력을 직접 확인했어요.</label><details class="z-help"><summary>고급 설정</summary><div class="z-form-grid">${numberField("gas.threshold", "경보 기준 ADC", g.threshold, 1, 1022)}${numberField("gas.recovery", "복귀 기준 ADC", g.recovery, 1, 1022)}${numberField("gas.holdSeconds", "경보 지속 확인(초)", g.holdSeconds, 5, 60)}${numberField("gas.recoverySeconds", "복귀 지속 확인(초)", g.recoverySeconds, 5, 60)}</div><p class="z-footnote">기준값 ≤ 복귀 기준 &lt; 경보 기준으로 직접 정해요. 검증된 안전 기준값이 아니에요. 0·측정 실패로 경보를 해제하지 않아요. 가스를 방출해 시험하지 마세요.</p></details><p class="z-footnote">경보·복귀 기준도 직접 정한 뒤 저장해 주세요. 감시는 기기 관리에서 따로 시작해요.</p></section>`;
    this.main.innerHTML = this.heading("설정") + this.sectionNavigation("settings", this.setupSection, [["basic", "기본 설정"], ["door", "문 기준 확인"], ["gas", "가스 기준 확인"]]) + `<form class="z-settings-content" data-settings-form novalidate><fieldset data-settings-fields><legend class="z-sr-only">설정 수정</legend>${content}${this.settingsFooter()}</fieldset></form><div class="z-settings-links">${pageLink("quiet-time", "안심 시간 관리")}${pageLink("devices", "연결·감시 관리")}</div>`;
  }
  eventsHtml(rows, limit = 8) {
    if (!rows.length) return `<div class="z-empty">${icon("history", 27)}<h3>아직 기록이 없어요</h3><p>USB를 연결하고 실제 변화가 생기면 여기에 남아요.</p></div>`;
    return `<ol class="z-event-list">${rows.slice(0, limit).map(r => `<li><span class="z-event-icon ${["gas_alert", "intrusion_alert", "sensor_error"].includes(r.kind) ? "z-event-icon--alert" : ""}">${icon(r.kind.startsWith("gas") ? "gas" : r.kind.startsWith("usb") ? "usb" : r.kind.startsWith("led") ? "light" : r.kind.startsWith("buzzer") ? "sound" : "history", 17)}</span><div class="z-event-body"><div><h3>${esc(r.legacy && r.title || EVENT_TITLES[r.kind] || (r.legacy ? "이전 기록 · " + r.kind : r.kind))}</h3>${r.legacy ? badge("이전 기록") : !this.acknowledged.has(r.id) && this.unsaved.some(e => e.id === r.id) ? badge("전송 대기", "amber") : !this.data.durable ? badge("임시 기록") : ""}</div><p>${esc(r.detail)}</p><small>ADC ${r.gas_raw ?? "—"} · 거리 ${r.distance_cm ?? "—"}cm · LED ${r.led === null ? "—" : r.led ? "켜짐" : "꺼짐"} · 부저 ${r.buzzer === null ? "—" : r.buzzer ? "작동" : "정지"}</small><time datetime="${esc(r.created_at)}">${timeLabel(r.created_at)}</time></div></li>`).join("")}</ol>`;
  }
  recentEvents() { const map = new Map(); for (const r of [...(this.data.events || []), ...this.localEvents]) map.set(r.id, r); return [...map.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50); }
  renderEvents() { for (const node of this.root.querySelectorAll("[data-events]")) { const kind = node.dataset.eventsKind; node.innerHTML = this.eventsHtml(this.recentEvents().filter(r => !kind || r.kind.startsWith(kind === "distance" ? "door" : "gas") || r.kind === "sensor_error" || r.kind === "sensor_recovered"), this.page === "home" ? 3 : 8); } }
  renderHistory() {
    const f = this.recordFilter;
    this.main.innerHTML = this.heading("기록", "한국 시간 기준이에요.") + `<section class="z-panel"><div class="z-history-filter">${field("historyDay", "날짜", f.day, 'type="date"')}<label class="z-field"><span id="z-history-kind-label">기록 종류</span><select name="historyKind" aria-labelledby="z-history-kind-label">${[["all", "전체"], ["gas", "가스 출력"], ["intrusion", "출입 의심"], ["door", "거리 변화"], ["usb", "USB 연결"], ["sensor", "센서 오류·복구"], ["led", "LED"], ["buzzer", "부저"], ["command", "제어 요청·응답"]].map(([v, label]) => `<option value="${v}" ${f.kind === v ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="z-btn" data-action="export">${icon("download", 16)}기록 내보내기</button></div><div data-record-results aria-busy="${Boolean(this.recordsLoading)}">${this.historyResults()}</div></section>${this.importPanel()}`;
  }
  historyResults() {
    const r = this.recordResult, f = this.recordFilter;
    return `${this.recordsError ? `<p class="z-error" role="alert">${esc(this.recordsError)}</p>` : ""}${this.recordsLoading ? '<p class="z-empty" role="status">기록을 불러오고 있어요.</p>' : this.eventsHtml(r.rows, 50)}<div class="z-pagination"><span role="status">전체 ${Number(r.total).toLocaleString("ko-KR")}건 · 한 번에 50건</span><div><button class="z-btn z-btn--small" data-action="history-prev" ${!f.offset || this.recordsLoading ? "disabled" : ""}>이전</button><button class="z-btn z-btn--small" data-action="history-next" ${f.offset + 50 >= r.total || this.recordsLoading ? "disabled" : ""}>다음</button></div></div>`;
  }
  importPanel() {
    return `<details class="z-panel z-import-panel z-help"><summary>기록 가져오기</summary><p class="z-description">선택한 자료만 추가해요. 기존 기록은 삭제하거나 덮어쓰지 않아요. 비밀번호·연결 키는 내보내지 않아요.</p><label class="z-field"><span>이전 집온 JSON · 2MB 이하, 최대 5,000건</span><input type="file" name="importFile" accept="application/json,.json"></label><label class="z-check z-check--wrap"><input type="checkbox" name="importSettings">자료에 포함된 설정도 가져오기 · 감시는 자동 시작하지 않아요.</label><div class="z-buttons"><button class="z-btn" data-action="import">이전 기록 가져오기</button></div><p class="z-footnote">설정도 가져오려면 기기 관리에서 USB 연결을 먼저 해제해 주세요.</p></details>`;
  }
  renderDevices() {
    this.main.innerHTML = this.heading("기기 관리") + this.connectionCard() + this.monitoringControls() + `<section class="z-panel"><div class="z-section-head"><h2>센서 점검</h2>${pageLink("monitor", "측정값·그래프")}</div><div class="z-sensor-check"><div><span>가스 원시 출력</span><b><span data-live="currentGas">—</span> ADC</b><span data-live="gasState" class="z-badge">연결 전</span></div><div><span>초음파 거리</span><b><span data-live="currentDistance">—</span> cm</b><span data-live="distanceState" class="z-badge">연결 전</span></div></div><p class="z-footnote">0·1023·무응답은 정상이나 안전을 뜻하지 않아요. 전원을 모두 끄고 배선을 바꿔 주세요.</p></section><div class="z-alarm" role="alert" data-alarm hidden></div><details class="z-panel z-help z-install-help"><summary>현재 배선·설치 안내</summary><div class="z-section-head"><div><h2>UNO R3 · USB V4</h2><p>이전 V3 코드와 섞지 마세요.</p></div>${badge("실물 점검 필요", "amber")}</div>
      <div class="z-pin-grid">${[["가스 센서 AO", "A5"], ["초음파 Trig", "D9"], ["초음파 Echo", "D8"], ["수동 피에조", "D6"], ["LED + 330Ω", "D7"]].map(([label, pin]) => `<div><span>${label}</span><b>${pin}</b></div>`).join("")}</div>
      <p class="z-description">현재는 USB로 켠 UNO의 5V를 초음파·MQ-135가 공유하는 단기 읽기 시험이에요. VCC는 5V, GND는 공통, AO는 A5이며 DO는 연결하지 않아요. 이 구성의 전원 여유는 실물 확인 전이에요.</p>
      <div class="z-callout">${icon("info")}<div><p><b>전원을 모두 끄고 배선을 바꿔 주세요.</b> 외부 커패시터는 사용하지 않아요. LED D7의 330Ω 직렬 저항과 수동 피에조 D6의 구동 조건을 확인해 주세요.</p><p>재시작·USB 끊김·보드나 케이블 과열·타는 냄새가 나면 전원을 분리해요. 이 단기 시험을 9V/VIN 전원 구성으로 일반화하지 않아요. 센서가 가열되지 않거나 ADC 1023이 계속되면 전원·배선·모듈을 점검해야 해요.</p><p>포트가 열리지 않으면 시리얼 모니터·플로터·기존 중계·다른 USB 연결 탭을 닫고 다시 연결해 주세요.</p></div></div>
       <div class="z-buttons z-install-downloads"><button class="z-btn z-btn--primary" data-action="download" data-file="kit">${icon("download", 16)}V4 설치 묶음 받기</button><button class="z-btn" data-action="download" data-file="sketch">스케치 전문</button><button class="z-btn" data-action="download" data-file="wiring">배선도</button><button class="z-btn" data-action="download" data-file="guide">설치 안내</button></div><ol class="z-install-list"><li>D9/D8·LED D7용 V4 스케치를 Arduino Uno에 업로드해요.</li><li>시리얼 모니터와 기존 중계를 닫고, 이 컴퓨터의 지원 브라우저에서 USB 연결을 눌러요.</li><li>실제 ADC·거리와 측정 오류를 확인해요. 초음파 NO ECHO는 출입이 아니에요.</li><li>감시 기준·허용 시간표를 저장한 뒤 기기 관리에서 감시를 각각 시작해요.</li></ol><div class="z-callout">${icon("info")}<p>자동 경보와 실제 빛·소리는 직접 확인해야 해요. USB 단절 후 수동·출입 출력은 약 3초 안에 종료하도록 작성했지만, 보드 전원이 남으면 가스 자동 경보는 계속될 수 있어요.</p></div></details>
      <details class="z-panel z-help"><summary>실행·보관 도움말</summary><p class="z-description">기존 V3 화면·중계·기록은 별도로 보존돼요. 가족 비밀번호와 기록 보관 연결은 실행하는 곳에도 설정해야 해요.</p><button class="z-btn" data-action="download" data-file="deployment">GitHub·Streamlit 안내 받기</button><p class="z-footnote">보관 연결 실패를 임시 저장이나 성공으로 바꾸지 않아요. 한 화면만 USB 측정을 전송하며, 다른 기기는 저장한 기록·지난 보고를 읽을 수 있어요. 다른 컴퓨터의 USB는 원격 제어하지 않아요.</p></details>`;
    this.updateLive();
  }
  updateLive() {
    if (!this.main) return;
    const saved = this.data.lastState;
    const remote = !this.usb?.port && saved?.sample && (!this.last || Date.parse(saved.last_seen) > (this.sampleWallTime || 0));
    // The transport announces freshness just before delivering its first sample.
    // Never enable controls or read sample fields during that empty-state handoff.
    const p = remote ? saved.sample : this.last, fresh = Boolean(!remote && p && this.usb?.fresh), storageHealthy = !this.data.storageError && (this.data.durable || this.data.mode === "development"), canControl = fresh && this.lease && !this.commandBusy && storageHealthy;
    const set = (key, value, tone) => { for (const node of this.root.querySelectorAll(`[data-live="${key}"]`)) { node.textContent = value; if (tone) node.className = `z-badge z-badge--${tone}`; } };
    const states = { disconnected: "연결 전", choosing: "포트 선택 중", opening: "연결 확인 중", waiting: "측정 대기", connected: "연결됨", stale: "측정 중단", error: "연결 오류" };
    set("connectionBadge", states[this.connection.state] || "연결 전", fresh ? "green" : ["stale", "error"].includes(this.connection.state) ? "red" : "muted"); set("connectionMessage", this.connection.message);
    if (remote) set("connectionMessage", "보관된 마지막 보고만 보여요. 제어하려면 이 컴퓨터에서 USB를 직접 연결해 주세요.");
    const gstate = fresh && (p?.gasRaw === 0 || p?.gasRaw === 1023 || p?.gasRaw === null) ? "측정 점검" : fresh ? ({ disabled: "감시 꺼짐", below: "기준 아래", watch: "상승 확인 중", alert: "출력 경고", fault: "측정 오류" }[p?.gasState] || "확인 중") : p ? "지난 측정" : "연결 전";
    set("gasState", gstate, fresh && p?.gasAlarm ? "red" : fresh && ["watch", "fault"].includes(p?.gasState) ? "amber" : fresh && p?.gasState === "below" ? "green" : "muted");
    set("gasValue", p?.gasRaw === null || p?.gasRaw === undefined ? "—" : p.gasRaw.toLocaleString("ko-KR"));
    set("gasNote", !fresh && p ? "지난 측정값이에요. 현재 상태는 확인되지 않았어요." : p?.gasRaw === 1023 ? "최대 출력이에요. 농도·가스 종류는 알 수 없어요." : p?.gasRaw === 0 ? "0 출력이에요. 정상·안전으로 판단하지 않아요." : "가스 농도가 아닌 원시 출력이에요.");
    set("gasAlarm", p?.gasAlarm ? fresh ? "출력 경고 · 현장 확인 필요" : "지난 출력 경고 · 현장 확인 필요" : fresh ? p?.gasState === "disabled" ? "감시 꺼짐" : p?.gasState === "fault" ? "측정 오류" : "출력 경고 없음 · 안전 판정 아님" : "현재 확인 안 됨");
    set("currentGas", fresh && p?.gasRaw != null ? p.gasRaw.toLocaleString("ko-KR") : "—");
    set("gasVoltage", fresh && p?.gasRaw != null ? `${(p.gasRaw * 5 / 1023).toFixed(2)} V · 5V 가정` : "확인 불가");
    set("gasComparisonNote", p?.gasAlarm ? fresh ? "원시 출력 경고" : "지난 출력 경고" : "농도 미측정");
    const rawRange = this.root.querySelector("[data-raw-range]"); if (rawRange) rawRange.value = fresh && p?.gasRaw != null ? p.gasRaw : 0;
    const baseline = this.settings.intrusion.baselineConfirmed === true ? this.settings.intrusion.baselineCm : null;
    const comparison = compareDoorDistance(p?.distanceCm, baseline, fresh);
    set("doorComparison", comparison.state === "within" ? "기준 범위" : comparison.state === "outside" ? "거리 변화" : "확인 불가");
    set("currentDistance", fresh && p?.distanceCm != null ? p.distanceCm.toFixed(1) : "—");
    set("doorBaseline", baseline === null ? "—" : baseline.toFixed(1));
    set("doorDelta", comparison.delta === null ? "—" : `${comparison.delta > 0 ? "+" : ""}${comparison.delta.toFixed(1)}`);
    set("doorReason", !fresh ? "새 측정값이 없어 현재 문 상태를 확인할 수 없어요." : p?.distanceCm == null ? "초음파 응답이 없어요. 문 열림으로 처리하지 않아요." : baseline === null ? "문을 실제로 닫고 설정에서 기준 거리를 확인해 주세요." : comparison.state === "within" ? "닫힘 기준에서 ±10cm 이내에 있어요." : "닫힘 기준에서 10cm 넘게 벗어났어요. 실제 문을 확인해 주세요.");
    const doorPanel = this.root.querySelector("[data-door-comparison]"); if (doorPanel) doorPanel.dataset.comparison = comparison.state;
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
    for (const b of this.root.querySelectorAll('[data-action="gas-start"], [data-action="gas-stop"]')) b.disabled = !canControl || !gasReady(this.settings) || Boolean(p?.gasAlarm) || b.dataset.action === "gas-start" && !(p?.gasRaw > 0 && p?.gasRaw < 1023);
    const start = this.root.querySelector('[data-action="intrusion-start"]'); if (start) start.disabled = !canControl || !this.settings.intrusion.enabled || p?.distanceCm === null || this.intrusionArmed;
    const stop = this.root.querySelector('[data-action="intrusion-stop"]'); if (stop) stop.disabled = !canControl || !this.intrusionArmed;
    const isOpen = Boolean(this.usb?.port || this.usb?.opening);
    for (const b of this.root.querySelectorAll('[data-action="connect"]')) { b.hidden = isOpen; b.disabled = !navigator.serial || !globalThis.isSecureContext || !storageHealthy; }
    for (const b of this.root.querySelectorAll('[data-action="reconnect"]')) { b.hidden = isOpen || !this.usb?.savedPort; b.disabled = this.usb?.opening || !storageHealthy; }
    for (const b of this.root.querySelectorAll('[data-action="disconnect"]')) b.hidden = !isOpen;
    for (const b of this.root.querySelectorAll('[data-action="use-distance"]')) b.disabled = this.savingSettings || !fresh || p?.distanceCm == null || p.distanceCm > 390;
    for (const b of this.root.querySelectorAll('[data-action="use-gas"]')) b.disabled = this.savingSettings || !fresh || !(p?.gasRaw > 0 && p?.gasRaw < 1023);
    const notification = this.root.querySelector('[data-action="notification"]');
    if (notification) { notification.disabled = !("Notification" in globalThis); notification.textContent = this.browserNotifications ? "알림 끄기" : "알림 켜기"; notification.setAttribute("aria-pressed", String(Boolean(this.browserNotifications))); }
    set("notificationStatus", !("Notification" in globalThis) ? "이 브라우저에서는 화면 안 기록을 확인해 주세요." : globalThis.Notification.permission === "denied" ? "알림이 차단되어 있어요. 브라우저 설정에서 허용해 주세요." : this.browserNotifications ? "이 화면을 열어 둔 동안만 알려줘요." : "이 기기에만 적용돼요. 앱 종료·잠금 중 비상 알림은 없어요.");
    const alarm = this.root.querySelector("[data-alarm]");
    if (alarm) { alarm.hidden = !(p?.gasAlarm || fresh && p?.intrusionAlarm); alarm.textContent = p?.gasAlarm ? `${fresh ? "가스 원시 출력 경고" : "지난 가스 출력 경고 · 현재 확인 불가"} · 설정한 ADC 기준의 실습용 경보이며 화재·누출 판정이 아니에요. 실제 상황을 직접 확인해 주세요.` : "출입 의심 · 허용 시간 밖의 거리 변화예요. 사람의 출입이 확정된 것은 아니에요."; }
    const storageError = this.root.querySelector("[data-storage-error]");
    if (storageError) { storageError.hidden = !this.data.storageError; storageError.textContent = this.data.storageError || ""; }
    const sync = this.root.querySelector("[data-sync]");
    if (sync) { sync.hidden = !this.unsaved.length && !this.saveError && !this.droppedEvents; sync.textContent = this.droppedEvents ? `전송 대기가 한도를 넘어 ${this.droppedEvents}건을 보관하지 못했어요. ${this.unsaved.length}건 전송 대기 중이에요.` : this.saveError ? `${this.saveError} ${this.unsaved.length}건이 이 화면에서 전송을 기다려요. 화면을 닫기 전에 연결을 확인해 주세요.` : `${this.unsaved.length}건이 전송을 기다리고 있어요. 닫기 전에 저장 여부를 확인해 주세요.`; }
    const storage = this.root.querySelector("[data-storage]");
    if (!navigator.serial && storage) { const desc = this.root.querySelector('[data-live="connectionMessage"]'); if (desc) desc.textContent = "이 브라우저는 USB 직접 연결을 지원하지 않아요. 데스크톱 Chrome·Edge에서 앱을 열어 주세요."; }
  }
  async destroy() {
    this.destroyed = true; clearInterval(this.timer); clearTimeout(this.toastTimer);
    if (this.pendingRequest) { clearTimeout(this.pendingRequest.timer); this.pendingRequest.reject(new Error("가족 공간이 닫혔어요.")); this.pendingRequest = null; }
    this.root.removeEventListener("click", this.onClick); this.root.removeEventListener("input", this.onChange); this.root.removeEventListener("change", this.onChange); this.root.removeEventListener("submit", this.onSubmit);
    document.removeEventListener("visibilitychange", this.onVisibility); window.removeEventListener("pagehide", this.onPageHide); window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.destroyCharts(); await this.usb.destroy();
  }
}
