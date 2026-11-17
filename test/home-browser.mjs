// Run against the existing preview; all app requests use isolated, temporary test storage.
// No real family password, records, device, or buzzer is used by this check.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHomeHarness } from "./home-harness.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("/usr/local/lib/node_modules/playwright");
const { expect } = require("/usr/local/lib/node_modules/playwright/test");
const origin = process.env.PREVIEW_URL ?? "http://localhost:5173";
const screenshots = "/tmp/opencode/zipon-check";
await mkdir(screenshots, { recursive: true });
const home = await createHomeHarness();
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const snapshotBlocks = new WeakMap();
let checks = 0;
let autoTimer;
let autoPending = Promise.resolve();
async function checked(label, work) { await work(); checks++; console.log(`통과 · ${label}`); }
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport, locale: "ko-KR", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 4")) errors.push(message.text());
  });
  await context.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    try {
      const response = await home.fetch(`${url.pathname}${url.search}`, { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) });
      if (response.status >= 500) errors.push(`집 소식 요청 실패: ${response.status}`);
      const body = await response.text(), block = snapshotBlocks.get(page);
      // Hold an already-created response, like slow network transit. Its
      // serverTime must not restart the measurement lifetime on late arrival.
      if (block && url.pathname === "/api/home/snapshot") { block.waiting++; await block.promise; }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
      if (block && url.pathname === "/api/home/snapshot") block.delivered++;
    } catch (error) { errors.push(error.message); await route.abort(); }
  });
  return { page, context };
}
async function unlock(page) {
  await page.getByLabel("가족 비밀번호", { exact: false }).fill(home.password);
  await expect(page.getByRole("button", { name: "가족 공간 열기", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "가족 공간 열기", exact: true }).click();
}
async function noOverflow(page) {
  const measure = () => page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth + 1) return [];
    return [...document.querySelectorAll("main *, header *")].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.right > window.innerWidth + 1 || box.left < -1);
    }).slice(0, 12).map(element => `${element.tagName}.${element.className}`);
  });
  await expect.poll(measure, { message: "화면 크기 변경 후 가로 넘침이 없어야 해요" }).toEqual([]);
}
async function screenshot(page, filename) {
  await page.locator(".toast").waitFor({ state: "hidden" });
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `${screenshots}/${filename}.png`, fullPage: true });
}
async function storedSettings() {
  return JSON.parse((await home.db.prepare("SELECT value FROM home_settings WHERE scope = 'family'").first()).value);
}
async function saveSettings(page) {
  await page.getByRole("button", { name: "설정 저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "설정 저장", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "우리 집 설정을 저장했어요." })).toBeVisible();
}
const navigate = (page, name) => page.getByRole("navigation", { name: /^(모바일 )?주 메뉴$/ }).getByRole("link", { name, exact: true }).click();

async function downloadHardware(page) {
  const link = page.getByRole("link", { name: "아두이노 코드·연결 안내 받기", exact: true });
  await expect(link).toHaveAttribute("href", /^blob:/);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  assert.equal(download.suggestedFilename(), "zipon-mq135-usb-kit.zip");
  assert.equal(await download.failure(), null);
  assert.deepEqual(await readFile(await download.path()), await readFile(new URL("../public/downloads/zipon-mq135-usb-kit.zip", import.meta.url)));
}

try {
  const { page } = await pageFor({ width: 1440, height: 1000 });
  await checked("직접 연 설정 화면도 비밀번호 전에는 잠김", async () => {
    await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "우리 가족 공간 열기" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "우리 집 알림 설정" })).toHaveCount(0);
    await noOverflow(page);
  });
  await checked("틀린 비밀번호 안내와 올바른 비밀번호로 열기", async () => {
    await page.getByLabel("가족 비밀번호", { exact: false }).fill(`wrong-${crypto.randomUUID()}`);
    await page.getByRole("button", { name: "가족 공간 열기", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("가족 비밀번호가 맞지 않아요");
    await unlock(page);
    await expect(page.getByRole("heading", { name: "우리 집 알림 설정" })).toBeVisible();
    await expect(page.locator(".quiet-window")).toHaveCount(1);
  });
  await checked("안심 시간 추가·요일·자정 넘김을 저장하고 다시 읽기", async () => {
    await page.getByRole("button", { name: "안심 시간 추가", exact: true }).click();
    const second = page.locator(".quiet-window").nth(1);
    await second.getByLabel("안심 시간 이름", { exact: false }).fill("학교 간 시간");
    await second.getByLabel("시작 시간", { exact: false }).fill("08:30");
    await second.getByLabel("종료 시간", { exact: false }).fill("16:00");
    await page.getByRole("button", { name: "안심 시간 추가", exact: true }).click();
    const third = page.locator(".quiet-window").nth(2);
    await third.getByLabel("안심 시간 이름", { exact: false }).fill("주말 밤 시간");
    await third.getByLabel("시작 시간", { exact: false }).fill("23:30");
    await third.getByLabel("종료 시간", { exact: false }).fill("06:15");
    for (const day of ["월", "화", "수", "목", "금", "토"]) await third.getByRole("button", { name: `${day}요일`, exact: true }).click();
    await expect(third.getByText("선택한 요일에 시작해 다음 날 끝나요.")).toBeVisible();
    await saveSettings(page);
    const settings = await storedSettings();
    assert.equal(settings.quietWindows.length, 3);
    assert.deepEqual(settings.quietWindows[2].days, [6]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".quiet-window")).toHaveCount(3);
    await expect(page.locator(".quiet-window").nth(2).getByLabel("시작 시간", { exact: false })).toHaveValue("23:30");
    await expect(page.locator(".quiet-window").nth(1).getByLabel("안심 시간 이름", { exact: false })).toHaveValue("학교 간 시간");
  });
  await checked("잘못된 시간과 빈 반복 요일의 저장을 막음", async () => {
    const first = page.locator(".quiet-window").first();
    await first.getByLabel("종료 시간", { exact: false }).fill("22:00");
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("시작 시간과 종료 시간을 다르게");
    assert.equal((await storedSettings()).quietWindows[0].end, "07:00");
    await first.getByLabel("종료 시간", { exact: false }).fill("07:00");
    for (const day of ["월", "화", "수", "목", "금"]) await page.locator(".quiet-window").nth(1).getByRole("button", { name: `${day}요일`, exact: true }).click();
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("반복 요일을 하나 이상");
    await page.locator(".quiet-window").nth(1).getByRole("button", { name: "월요일", exact: true }).click();
    await saveSettings(page);
  });
  await checked("시간 삭제 되돌리기와 개별 사용 중지", async () => {
    await page.getByRole("button", { name: "안심 시간 2 삭제", exact: true }).click();
    await expect(page.locator(".quiet-window")).toHaveCount(2);
    await page.getByRole("button", { name: "되돌리기", exact: true }).click();
    await expect(page.locator(".quiet-window")).toHaveCount(3);
    await page.getByRole("switch", { name: "안심 시간 2 사용", exact: true }).click();
    await saveSettings(page);
    assert.equal((await storedSettings()).quietWindows[1].enabled, false);
    await screenshot(page, "settings-desktop");
  });
  await checked("휴대폰에서도 시간 입력과 삭제·저장·다시 열기", async () => {
    const { page: mobile } = await pageFor({ width: 390, height: 844 });
    await mobile.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
    await unlock(mobile);
    await expect(mobile.locator(".quiet-window")).toHaveCount(3);
    await noOverflow(mobile);
    await screenshot(mobile, "settings-mobile");
    await mobile.getByRole("button", { name: "안심 시간 3 삭제", exact: true }).click();
    await saveSettings(mobile);
    await mobile.reload({ waitUntil: "domcontentloaded" });
    await expect(mobile.locator(".quiet-window")).toHaveCount(2);
    assert.equal((await storedSettings()).quietWindows.length, 2);
    await mobile.setViewportSize({ width: 320, height: 740 });
    await noOverflow(mobile);
    await screenshot(mobile, "settings-small-mobile");
  });
  await checked("기기 연결 전 실제 측정값·기록이 없고 사이렌이 비활성", async () => {
    await navigate(page, "우리 집");
    await expect(page.locator(".home-hero")).toContainText("집의 소식을");
    await expect(page.locator(".sensor-number").first()).toContainText("—");
    await expect(page.getByRole("button", { name: "부저 켜기", exact: false })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "오늘 감지된 문 움직임이 없어요" })).toBeVisible();
    await expect(page.getByText(/체험|예시 기록|상황 체험/)).toHaveCount(0);
    await noOverflow(page);
    await screenshot(page, "home-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await screenshot(page, "home-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  let token;
  await checked("USB 코드 안내·다운로드와 기기 연결 키의 일회 표시", async () => {
    const requests = [];
    const downloadRoute = async route => {
      const navigation = route.request().isNavigationRequest();
      requests.push(navigation);
      // Regression check: the file must still download if direct HTTP file
      // navigation is unavailable. The preview's ordinary fetch can read it.
      if (navigation) return route.fulfill({ status: 403, body: "direct download unavailable" });
      return route.continue();
    };
    await page.route("**/downloads/zipon-mq135-usb-kit.zip", downloadRoute);
    await navigate(page, "기기 관리");
    await expect(page.getByRole("heading", { name: "노트북으로 USB 연결" })).toBeVisible();
    await expect(page.locator(".usb-guide")).toContainText("AO → A5 · DO 미연결 · D10 미사용");
    await expect(page.locator(".usb-guide")).toContainText("별도 안정화 5V");
    const diagram = page.getByRole("img", { name: /MQ-135 VCC는 별도 5V/ });
    await expect(diagram).toBeVisible();
    assert.ok(await diagram.evaluate(img => img.complete && img.naturalWidth > 0));
    await downloadHardware(page);
    assert.ok(requests.length >= 1);
    assert.ok(requests.every(navigation => navigation === false));
    await page.unroute("**/downloads/zipon-mq135-usb-kit.zip", downloadRoute);
    await expect(page.locator(".unavailable-feature").filter({ hasText: "앱 종료·잠금 중 비상 알림" })).toContainText("구현되지 않음");
    await screenshot(page, "devices-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await screenshot(page, "devices-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "기기 연결 키 만들기", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "기기 연결 키를 만들었어요" })).toBeVisible();
    token = await page.locator(".key-display code").innerText();
    assert.match(token, /^[a-f0-9]{64}$/);
    await page.getByRole("button", { name: "연결 키를 보관했어요", exact: true }).click();
    await expect(page.locator(".key-display code")).toHaveText("");
    assert.equal((await storedSettings()).quietWindows.length, 2);
  });
  await checked("잘못된 다운로드 응답은 저장하지 않고 재시도로 정상 ZIP 저장", async () => {
    let fail = true;
    const downloadRoute = route => fail ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>not a ZIP</title>" }) : route.continue();
    const downloads = [];
    const onDownload = download => downloads.push(download);
    page.on("download", onDownload);
    await page.route("**/downloads/zipon-mq135-usb-kit.zip", downloadRoute);
    await page.setViewportSize({ width: 558, height: 760 });
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: "파일을 준비하지 못했어요" })).toBeVisible();
    const retry = page.getByRole("button", { name: "파일 준비 다시 시도", exact: true });
    await expect(retry).toBeEnabled();
    assert.equal(downloads.length, 0);
    await noOverflow(page);
    await screenshot(page, "download-error-558");
    fail = false;
    await retry.click();
    await downloadHardware(page);
    assert.equal(downloads.length, 1);
    await expect(page.locator("#hardware-download-error")).toHaveCount(0);
    await noOverflow(page);
    await screenshot(page, "download-fixed-558");
    await page.unroute("**/downloads/zipon-mq135-usb-kit.zip", downloadRoute);
    page.off("download", onDownload);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await checked("MQ-135 ADC·V 표시·끝값 경고·측정 실패와 이전 경보 구분", async () => {
    const sample = async (id, adc = 512) => {
      const response = await home.fetch("/api/device/telemetry", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sampleId: id, gasSensor: "MQ-135", gasAdc: adc, gasVoltageV: adc === null ? null : Math.round(adc * 5 / 1023 * 10000) / 10000, dustUgM3: null, distanceCm: 12 }) });
      assert.equal(response.status, 200);
    };
    await sample("browser-usb:1");
    await navigate(page, "우리 집");
    await page.reload();
    const card = page.locator(".sensor-card").filter({ has: page.getByRole("heading", { name: "가스 센서 출력" }) });
    await expect(card).toContainText("2.50");
    await expect(card).toContainText("ADC 512");
    await expect(card).toContainText("가스 누출 여부는 판단하지 않아요");
    await expect(card.locator(".sensor-number")).toContainText("V");
    await expect(card).not.toContainText("µg/m³");
    await expect(card).not.toContainText("수치 정상");
    assert.equal((await home.db.prepare("SELECT COUNT(*) AS n FROM home_alerts WHERE kind = 'fire_risk'").first()).n, 0);
    await screenshot(page, "usb-home-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await screenshot(page, "usb-home-mobile");
    for (const [index, adc] of [0, 1023].entries()) {
      await sample(`browser-endpoint:${index}`, adc);
      await page.reload();
      await expect(card).toContainText("범위 끝값");
      await expect(card).toContainText(`ADC ${adc}`);
      await expect(card).toContainText(adc === 0 ? "0.00" : "5.00");
      await expect(card).not.toContainText("수치 정상");
    }
    await sample("browser-usb:2");
    await page.setViewportSize({ width: 320, height: 760 });
    await noOverflow(page);
    await page.goto(`${origin}/devices`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "우리 집 기기", exact: true })).toBeVisible();
    await noOverflow(page);
    const part = page.locator(".device-part").filter({ has: page.getByRole("heading", { name: "가스 센서", exact: true }) });
    await expect(part).toContainText("측정값 수신");
    await expect(part).toContainText("농도·안전 판정 안 함");
    await screenshot(page, "usb-devices-320");
    await sample("browser-usb:3", null);
    await page.reload();
    await expect(part).toContainText("측정 실패");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate(page, "우리 집");
    await expect(card.locator(".sensor-number")).toContainText("—");
    // Only the disposable test state is changed, never a real family alarm.
    await home.db.prepare("UPDATE home_state SET value = json_set(value, '$.fireStatus', 'risk') WHERE scope = 'family'").run();
    await sample("browser-usb:4", 0);
    await page.reload();
    await expect(card).toContainText("이전 경보 유지");
    await expect(page.locator(".home-hero")).toContainText("이전에 남은 경보를 유지");
    await sample("browser-usb:5");
    await page.reload();
    await expect(card).toContainText("이전 경보 유지");
    await screenshot(page, "mq135-previous-alert");
  });
  await checked("문 거리 저장이 이전 센서 설정과 여러 안심 시간을 바꾸지 않는다", async () => {
    await navigate(page, "기기 관리");
    const before = await storedSettings();
    await expect(page.getByRole("heading", { name: "문 거리·가스 출력 기준", exact: true })).toBeVisible();
    await expect(page.locator("#sensor-dustThreshold")).toHaveCount(0);
    await page.locator("#sensor-closedDistance").fill("15");
    await page.getByRole("button", { name: "기준값 저장", exact: true }).click();
    await expect(page.getByRole("button", { name: "기준값 저장", exact: true })).toBeDisabled();
    assert.deepEqual(await storedSettings(), { ...before, closedDistance: 15 });
  });
  await checked("사이렌 재확인·대기·실행 응답·중지 응답 표시", async () => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const response = await home.fetch("/api/device/telemetry", { method: "POST", headers, body: JSON.stringify({ sampleId: "browser:1", gasSensor: "MQ-135", gasAdc: 512, gasVoltageV: 2.5024, dustUgM3: null, distanceCm: 12 }) });
    assert.equal(response.status, 200);
    await navigate(page, "우리 집");
    const start = page.getByRole("button", { name: "사이렌 울리기", exact: false });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByRole("dialog", { name: "사이렌을 요청할까요?" })).toBeVisible();
    const before = await home.db.prepare("SELECT COUNT(*) AS count FROM home_commands").first();
    assert.equal(before.count, 0);
    await page.getByRole("button", { name: "집에 사이렌 요청", exact: true }).click();
    await expect(page.locator(".siren-note")).toHaveText("아직 기기의 실행 응답을 받지 못했어요.");
    const command = await home.db.prepare("SELECT id, status FROM home_commands ORDER BY created_at DESC LIMIT 1").first();
    assert.equal(command.status, "pending");
    await home.fetch(`/api/device/commands/${command.id}/ack`, { method: "POST", headers, body: '{"status":"started"}' });
    await expect(page.locator(".siren-panel .status-pill")).toHaveText("실행 응답 수신");
    await page.getByRole("button", { name: "사이렌 멈추기", exact: true }).click();
    await expect(page.locator(".siren-note")).toContainText("중지 응답을 기다리고");
    const stop = await home.db.prepare("SELECT id FROM home_commands WHERE action = 'stop' ORDER BY created_at DESC LIMIT 1").first();
    await home.fetch(`/api/device/commands/${stop.id}/ack`, { method: "POST", headers, body: '{"status":"completed"}' });
    await expect(page.locator(".siren-note")).toContainText("기기에서 중지 응답을 받았어요");
  });
  const sid = "d".repeat(32);
  let autoSequence = 0, eventSequence = 0;
  const auto = { gasAdc: 260, gasVoltageV: 1.2708, distanceCm: 12.3,
    board: { session: sid, configRevision: "0".repeat(16), doorStatus: "unknown", gasStatus: "disabled", gasAlarm: false,
      ledOn: false, buzzerOn: false, ledSource: "off", buzzerSource: "off", muteSeconds: 0, ledOffSeconds: 0, buzzerOffSeconds: 0 } };
  const device = async (path, body) => {
    const response = await home.fetch(`/api/device${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  function pushV3(change = {}) {
    autoPending = autoPending.then(async () => {
      const { board, events, ...raw } = change;
      Object.assign(auto, raw); Object.assign(auto.board, board);
      const n = ++autoSequence;
      return device("/telemetry", { protocol: "ZIPON_AUTO_V3", sampleId: `${sid}:${n}`, gasSensor: "MQ-135", dustUgM3: null, ...auto,
        board: { ...auto.board, sequence: n, uptimeMs: n * 2000 },
        boardEvents: (events ?? []).map(kind => ({ sequence: ++eventSequence, kind, uptimeMs: n * 2000 - 1, gasAdc: auto.gasAdc, distanceCm: auto.distanceCm })) });
    });
    return autoPending;
  }
  const latestOutput = target => home.db.prepare("SELECT * FROM home_output_commands WHERE target = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(target).first();
  async function applyOutput(target) {
    const row = await latestOutput(target); assert.equal(row.status, "pending");
    await device(`/outputs/${row.id}/claim`, { session: sid });
    await device(`/outputs/${row.id}/ack`, { session: sid, status: "applied" });
    return row;
  }
  await checked("V3 문 보정·예열 확인·이번 연결 감시 시작과 보드 적용 응답을 구분", async () => {
    await pushV3();
    autoTimer = setInterval(() => { void pushV3().catch(error => errors.push(error.message)); }, 2000);
    await navigate(page, "기기 관리");
    const prepare = page.getByRole("button", { name: "이번 연결에서 감시 켜기 준비", exact: true });
    await expect(prepare).toBeDisabled();
    const before = await storedSettings();
    await page.getByRole("button", { name: "문이 닫힌 지금 거리로 보정", exact: true }).click();
    await expect(page.locator("#sensor-closedDistance")).toHaveValue("12.3");
    await page.getByRole("button", { name: "현재 ADC를 기준 칸에 넣기", exact: true }).click();
    await expect(page.locator("#gas-baseline")).toHaveValue("260");
    await expect(prepare).toBeDisabled();
    await page.getByRole("checkbox", { name: /제조사 예열·안정화 지침과 기준 ADC/ }).check();
    await prepare.click();
    assert.equal((await storedSettings()).gasEnabled, false);
    await page.getByRole("button", { name: "기준값 저장", exact: true }).click();
    await expect(page.getByRole("button", { name: "기준값 저장", exact: true })).toBeDisabled();
    const saved = await storedSettings();
    assert.equal(saved.gasEnabled, true); assert.equal(saved.gasArmSession, sid); assert.equal(saved.doorCalibrated, true);
    assert.deepEqual(saved.quietWindows, before.quietWindows); assert.equal(saved.dustThreshold, before.dustThreshold);
    await navigate(page, "우리 집");
    await expect(page.locator(".board-configuration")).toContainText("보드의 설정 적용 대기");
    const response = await pushV3();
    await pushV3({ board: { configRevision: response.config.revision, doorStatus: "closed", gasStatus: "below" } });
    await expect(page.locator(".board-configuration")).toContainText("저장한 설정 적용 응답 수신");
  });
  await checked("LED 요청·전달 승인·실행 응답·현재 출력이 각각 표시된다", async () => {
    const led = page.locator(".output-channel").filter({ has: page.getByRole("button", { name: /^LED 켜기 / }) });
    await page.getByRole("button", { name: /^LED 켜기 / }).click();
    await expect(led).toContainText("요청 대기");
    await expect(led.locator(".output-channel-status")).toContainText("꺼짐");
    const row = await latestOutput("led");
    await device(`/outputs/${row.id}/claim`, { session: sid });
    await expect(led).toContainText("USB 전달 준비·보드 응답 전");
    await expect(led.locator(".output-channel-status")).toContainText("꺼짐");
    await device(`/outputs/${row.id}/ack`, { session: sid, status: "applied" });
    await expect(led).toContainText("보드 실행 응답 수신");
    await expect(led.locator(".output-channel-status")).toContainText("꺼짐");
    await pushV3({ board: { ledOn: true, ledSource: "manual" } });
    await expect(led.locator(".output-channel-status")).toContainText("켜짐 · 수동 요청");
  });
  await checked("부저는 재확인 뒤 독립 요청하며 일시 정지도 새 보고를 기다린다", async () => {
    const count = (await home.db.prepare("SELECT COUNT(*) AS n FROM home_output_commands").first()).n;
    await page.getByRole("button", { name: "부저 시험 2초", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "부저를 울릴까요?" })).toBeVisible();
    assert.equal((await home.db.prepare("SELECT COUNT(*) AS n FROM home_output_commands").first()).n, count);
    await page.getByRole("button", { name: "부저 울리기 요청", exact: true }).click();
    await applyOutput("buzzer");
    await pushV3({ board: { buzzerOn: true, buzzerSource: "manual" } });
    const buzzer = page.locator(".output-channel").filter({ has: page.getByRole("button", { name: /^부저 켜기 / }) });
    await expect(buzzer.locator(".output-channel-status")).toContainText("켜짐 · 수동 요청");
    await page.getByRole("button", { name: "LED 끄기 30초", exact: true }).click();
    await applyOutput("led");
    await pushV3({ board: { ledOn: false, ledSource: "paused", ledOffSeconds: 30 } });
    await expect(buzzer.locator(".output-channel-status")).toContainText("켜짐 · 수동 요청");
    await page.getByRole("button", { name: "자동 경고음 60초 쉬기", exact: true }).click();
    await applyOutput("alarm");
    await expect(page.getByRole("button", { name: "자동 경고음 60초 쉬기", exact: true })).toBeVisible();
    await pushV3({ board: { buzzerOn: false, buzzerSource: "paused", muteSeconds: 60 } });
    await expect(page.getByRole("button", { name: "경고음 일시 정지 해제", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "경고음 일시 정지 해제", exact: true }).click();
    await applyOutput("alarm");
    await pushV3({ board: { ledSource: "off", ledOffSeconds: 0, buzzerSource: "off", muteSeconds: 0 } });
  });
  await checked("자동 문·가스 출력 경고의 기록과 실패·끊김을 안전 상태로 표시하지 않는다", async () => {
    await pushV3({ gasAdc: 500, gasVoltageV: 2.4438, distanceCm: 50, board: { doorStatus: "open", gasStatus: "alert", gasAlarm: true, ledOn: true, buzzerOn: true, ledSource: "gas", buzzerSource: "gas" }, events: ["door_open", "gas_alert"] });
    await expect(page.locator(".home-hero")).toContainText("가스 출력 이상");
    await expect(page.locator(".sensor-card").first()).toContainText("화재 여부 확인 필요");
    await expect(page.locator(".event-list")).toContainText("현관문이 열렸어요");
    await screenshot(page, "automation-home-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page); await screenshot(page, "automation-home-mobile");
    await navigate(page, "출입 기록");
    await page.getByRole("button", { name: "가스 출력", exact: true }).click();
    await expect(page.locator(".event-list")).toContainText("가스 출력 이상·화재 여부 확인 필요");
    await page.getByRole("button", { name: "제어·설정", exact: true }).click();
    await expect(page.locator(".event-list")).toContainText("LED·부저 제어를 요청했어요");
    await noOverflow(page); await screenshot(page, "automation-history-mobile");
    await navigate(page, "우리 집");
    await pushV3({ gasAdc: null, gasVoltageV: null, distanceCm: null, board: { gasStatus: "fault", doorStatus: "unknown", ledOn: false, buzzerOn: false } });
    await expect(page.locator(".sensor-card").nth(1)).toContainText("초음파 응답 없음·측정 실패");
    await expect(page.locator(".sensor-card").first()).toContainText("출력 이상 기록 유지");
    await expect(page.locator(".sensor-card").first().locator(".sensor-number")).toContainText("—");
    await screenshot(page, "automation-failed-sensors-mobile");
  });
  await checked("응답이 지연돼도 마지막 측정의 유효 시간이 지나면 켜기·시험을 막는다", async () => {
    clearInterval(autoTimer); autoTimer = null; await autoPending;
    await home.db.prepare("UPDATE home_state SET value = json_set(value, '$.lastSeen', ?) WHERE scope = 'family'").bind(new Date(Date.now() - 11000).toISOString()).run();
    await page.reload();
    await expect(page.getByRole("button", { name: /^LED 켜기 / })).toBeEnabled();
    let release;
    const block = { promise: new Promise(resolve => { release = resolve; }), waiting: 0, delivered: 0 };
    snapshotBlocks.set(page, block);
    try {
      await expect.poll(() => block.waiting).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: /^LED 켜기 / })).toBeDisabled({ timeout: 7000 });
    } finally { snapshotBlocks.delete(page); release(); }
    await expect.poll(() => block.delivered).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: /^LED 켜기 / })).toBeDisabled();
    await expect(page.locator(".output-channel-status").first()).toContainText("현재 출력 미확인");
    await expect(page.locator(".home-hero")).toContainText("가스 출력 이상");
    await noOverflow(page); await screenshot(page, "automation-offline-mobile");
    await page.setViewportSize({ width: 320, height: 740 }); await noOverflow(page);
    await navigate(page, "기기 관리"); await noOverflow(page); await screenshot(page, "automation-devices-320");
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await checked("가족 공간 닫기 후 비밀번호 제거와 재잠금", async () => {
    await page.getByRole("button", { name: "가족 공간 닫기", exact: true }).click();
    await expect(page.getByRole("heading", { name: "우리 가족 공간 열기" })).toBeVisible();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("zipon-family")), null);
    await page.goto(`${origin}/history`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "우리 가족 공간 열기" })).toBeVisible();
  });
  assert.deepEqual(errors, [], "예상하지 못한 화면 오류가 없어야 해요");
  console.log(`화면 검사 ${checks}개 통과 · 실제 가족 기록과 기기는 사용하지 않았어요.`);
} finally {
  clearInterval(autoTimer);
  await autoPending.catch(() => {});
  await browser.close();
  await home.close();
}
