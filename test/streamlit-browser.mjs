// Real Streamlit + browser, but a private temporary store/password and fake USB.
// Never reads/writes the family's existing preview or published records.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { installFakeUsb } from "./fake-v4-serial.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("/usr/local/lib/node_modules/playwright");
const { expect } = require("/usr/local/lib/node_modules/playwright/test");
const temporary = await mkdtemp(join(tmpdir(), "zipon-streamlit-isolated-"));
const screenshots = "/tmp/opencode/zipon-streamlit-check";
await mkdir(screenshots, { recursive: true });
const log = join(temporary, "streamlit.log"), db = join(temporary, "records.sqlite"), password = `격리 검사 ${crypto.randomUUID()}`;
const latency = join(temporary, "latency.txt");
const origin = "http://localhost:8502/streamlit-check/";
const errors = []; let checks = 0, browser, activePage;
const checked = async (label, action) => { await action(); checks++; console.log(`통과 · ${label}`); };
const app = page => page.locator("[data-zipon-root]");
const nav = (page, label) => label === "우리 집"
  ? page.locator(".z-brand, .z-mobile-brand").filter({ visible: true }).first().click()
  : page.getByRole("navigation", { name: /^(모바일 )?주 메뉴$/ }).filter({ visible: true }).getByRole("link", { name: label, exact: true }).click();
const confirm = (page, label) => page.getByRole("dialog").getByRole("button", { name: label, exact: true }).click();
const sample = (page, changes = {}) => page.evaluate(changes => { Object.assign(ziponTestUsb.port.state, changes); ziponTestUsb.port.sample(); }, changes);
const dbRead = sql => JSON.parse(execFileSync("python3", ["-B", "-c", "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchall()))", db, sql], { encoding: "utf8" }));
async function pageFor(width = 1440, height = 1000, fake = true) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "ko-KR", reducedMotion: "reduce", isMobile: width < 900, hasTouch: width < 900 });
  if (fake) await context.addInitScript(installFakeUsb, { auto: true });
  else await context.addInitScript(() => Object.defineProperty(navigator, "serial", { value: undefined, configurable: true }));
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", d => { if (d.type() === "beforeunload") void d.accept(); });
  return page;
}
async function unlock(page) {
  await page.getByLabel("가족 비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "가족 공간 열기", exact: true }).click();
  await app(page).waitFor();
}
async function saveSettings(page) {
  await page.getByRole("button", { name: "이번 접속에 적용", exact: true }).click();
  await expect(page.locator("[data-dirty]")).toHaveText("저장한 설정");
}
async function section(page, label, time = false) {
  await page.getByRole("navigation", { name: time ? "시간표 항목" : "설정 항목", exact: true }).getByRole("link", { name: label, exact: true }).click();
}
async function expand(page, selector) {
  const details = page.locator(selector);
  if (!await details.evaluate(n => n.open)) await details.locator(":scope > summary").click();
}
async function noOverflow(page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function shot(page, name) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}
try {
  execFileSync("serve-bg", [log, "uv", "run", "--frozen", "streamlit", "run", "test/streamlit_runner.py", "--server.address", "0.0.0.0", "--server.port", "8502", "--server.baseUrlPath", "streamlit-check", "--server.headless", "true"], { env: { ...process.env, ZIPON_BROWSER_TEST_PASSWORD: password, ZIPON_BROWSER_TEST_DB: db, ZIPON_BROWSER_TEST_LATENCY: latency, UV_PROJECT_ENVIRONMENT: join(homedir(), ".cache", "zipon-streamlit-venv"), PYTHONDONTWRITEBYTECODE: "1" }, stdio: "pipe" });
  await expect.poll(async () => { try { return (await fetch(origin + "_stcore/health")).status; } catch { return 0; } }, { timeout: 25000 }).toBe(200);
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = activePage = await pageFor();
  await checked("비밀번호 전에는 직접 연 모니터링·기록·제어가 없음", async () => {
    await page.goto(origin + "?page=monitor");
    await expect(page.getByRole("heading", { name: "우리 가족의 공간이에요" })).toBeVisible();
    await expect(app(page)).toHaveCount(0);
    await page.getByLabel("가족 비밀번호", { exact: true }).fill("isolated-wrong-password");
    await page.getByRole("button", { name: "가족 공간 열기", exact: true }).click();
    await expect(page.getByText("가족 비밀번호가 맞지 않아요. 다시 확인해 주세요.")).toBeVisible();
    await shot(page, "gate-desktop");
  });
  await checked("가족 잠금 해제·빈 그래프·임시 저장 안내·제어 잠금", async () => {
    await unlock(page);
    await expect(page.getByRole("heading", { name: "실시간 측정값", exact: true })).toBeVisible();
    await expect(page.locator("[data-live=gasValue]")).toHaveText("—");
    await expect(page.locator("[data-control], .z-arm-panel")).toHaveCount(0);
    await expect(page.locator("[data-storage]")).toContainText("임시 저장");
    await expect.poll(() => app(page).evaluate(n => Object.keys(n.ziponApp.charts).length)).toBe(2);
    await noOverflow(page); await shot(page, "monitor-empty-desktop");
  });
  await checked("가스·거리 기준과 여러 안심 시간을 적용하고 다시 읽기", async () => {
    await expect(page.getByRole("navigation", { name: "주 메뉴", exact: true }).getByRole("link")).toHaveText(["홈", "기록", "기기 관리", "안심 시간", "설정", "실시간"]);
    await nav(page, "설정");
    await page.getByLabel("집 이름 *", { exact: true }).fill("격리 검사 집");
    await saveSettings(page);
    await section(page, "가스 기준 확인");
    await page.getByLabel("직접 확인한 기준 ADC", { exact: true }).fill("100");
    await expand(page, ".z-settings-content .z-help");
    for (const [label, value] of [["경보 기준 ADC", "200"], ["복귀 기준 ADC", "150"]]) await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel("제조사 안내에 따른 예열과 실제 기준 출력을 직접 확인했어요.").check();
    await saveSettings(page);
    await section(page, "문 기준 확인"); await expand(page, ".z-settings-content .z-help");
    for (const [label, value] of [["변화 지속 확인(초)", "1"], ["복귀 지속 확인(초)", "1"], ["반복 방지 시간(초)", "5"]]) await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel("출입 감시 사용", { exact: true }).check();
    await saveSettings(page);
    await nav(page, "안심 시간");
    await page.getByRole("button", { name: "+ 안심 시간 추가", exact: true }).click();
    await page.locator(".z-window").nth(1).getByLabel("시간 이름", { exact: true }).fill("격리 낮 시간");
    await saveSettings(page);
    const saved = JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]);
    assert.equal(saved.homeName, "격리 검사 집"); assert.equal(saved.quietWindows.length, 2); assert.equal(saved.gas.threshold, 200);
    await page.reload(); await unlock(page);
    await expect(page.getByRole("heading", { name: "안심 시간", exact: true })).toBeVisible();
    assert.equal(JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]).homeName, "격리 검사 집");
  });
  await checked("잘못된 시간 저장 거절·삭제 되돌리기·개별 끄기", async () => {
    const first = page.locator(".z-window").first();
    await first.getByLabel("종료 시간", { exact: true }).fill("22:00");
    await page.getByRole("button", { name: "이번 접속에 적용", exact: true }).click();
    await expect(page.locator("[data-settings-error]")).toContainText("시간");
    assert.equal(JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]).quietWindows[0].end, "07:00");
    await first.getByLabel("종료 시간", { exact: true }).fill("07:00");
    await page.getByRole("button", { name: "격리 낮 시간 삭제", exact: true }).click();
    await page.getByRole("button", { name: "시간 삭제 되돌리기", exact: true }).click();
    await page.locator(".z-window").nth(1).getByLabel("사용", { exact: true }).uncheck();
    await saveSettings(page);
    assert.equal(JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]).quietWindows[1].enabled, false);
  });
  await checked("설정 취소·탭과 메뉴 이동 확인·기본값 검증과 메뉴별 역할 분리", async () => {
    const before = JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]);
    await section(page, "출입 허용 시간", true);
    await expect(page.getByRole("button", { name: "+ 안심 시간 추가", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "+ 허용 시간 추가", exact: true }).click();
    await page.getByRole("button", { name: "수정 취소", exact: true }).click();
    await expect(page.locator(".z-window")).toHaveCount(0);
    await nav(page, "설정"); await section(page, "기본 설정");
    await page.getByLabel("집 이름 *", { exact: true }).fill("저장하지 않을 이름");
    await page.getByRole("button", { name: "수정 취소", exact: true }).click();
    await expect(page.getByLabel("집 이름 *", { exact: true })).toHaveValue(before.homeName);
    await page.getByLabel("집 이름 *", { exact: true }).fill("이동 전 수정");
    await section(page, "가스 기준 확인"); await expect(page.getByRole("dialog")).toBeVisible(); await confirm(page, "취소");
    await expect(page.getByLabel("집 이름 *", { exact: true })).toHaveValue("이동 전 수정");
    await nav(page, "기록"); await confirm(page, "수정 버리고 이동");
    await expect(page.getByRole("heading", { name: "기록", exact: true })).toBeVisible();
    await nav(page, "설정"); await page.getByLabel("집 이름 *", { exact: true }).fill("");
    await page.getByRole("button", { name: "이번 접속에 적용", exact: true }).click();
    await expect(page.locator("[data-settings-error]")).toContainText("집 이름");
    await page.getByRole("button", { name: "수정 취소", exact: true }).click();
    assert.deepEqual(JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]), before);
    await nav(page, "홈"); await expect(page.locator('[data-action="connect"], .z-arm-panel, [name="importFile"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^LED 켜기/ })).toBeDisabled();
    await nav(page, "기기 관리"); await expect(page.locator('[data-action="manual-led-test"], [name="importFile"], [name="homeName"]')).toHaveCount(0);
  });
  await checked("USB 9600 연결 후 갱신·페이지 이동에도 reader 하나 유지", async () => {
    await page.getByRole("button", { name: "USB 연결", exact: true }).click();
    await expect(page.locator("[data-live=connectionBadge]")).toHaveText("연결됨");
    await nav(page, "홈"); await expect(page.getByRole("button", { name: /^LED 켜기/ })).toBeEnabled();
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.points.length), { timeout: 15000 }).toBeGreaterThan(4);
    await nav(page, "홈"); await nav(page, "실시간");
    const state = await page.evaluate(() => ({ opens: ziponTestUsb.port.opens, chooser: ziponTestUsb.chooserCalls, baud: ziponTestUsb.port.options.baudRate, locked: ziponTestUsb.port.readable.locked }));
    assert.deepEqual(state, { opens: 1, chooser: 1, baud: 9600, locked: true });
    await expect(app(page)).toHaveCount(1);
  });
  await checked("홈의 LED 켜기·끄기와 부저 재확인이 실제 출력 보고와 분리된다", async () => {
    await nav(page, "우리 집");
    await page.getByRole("button", { name: /^LED 켜기/ }).click();
    await expect(page.locator("[data-live=commandNote]")).toContainText("보드 실행 응답");
    await sample(page); await expect(page.locator("[data-live=ledControl]")).toHaveText("켜짐");
    await page.getByRole("button", { name: "수동 LED 끄기", exact: true }).click(); await sample(page);
    await expect(page.locator("[data-live=ledControl]")).toHaveText("꺼짐");
    const count = () => page.evaluate(() => ziponTestUsb.port.writes.map(JSON.parse).filter(p => p.type === "manual" && p.target === "buzzer").length);
    const before = await count();
    await page.getByRole("button", { name: /^부저 울리기/ }).click(); await confirm(page, "취소"); assert.equal(await count(), before);
    await page.getByRole("button", { name: /^부저 울리기/ }).click(); await confirm(page, "부저 2초 시험");
    await expect.poll(count).toBe(before + 1); await sample(page); await expect(page.locator("[data-live=buzzerControl]")).toHaveText("작동");
    await expect(page.locator("[data-live=buzzerControl]")).toHaveText("정지", { timeout: 5000 });
    await noOverflow(page); await shot(page, "home-connected-desktop");
  });
  await checked("가스 판단 불가·문 직접 확인·±10cm 경계·무응답을 상세 화면에서 구분", async () => {
    await page.getByRole("link", { name: "문 작동 확인 상세 보기", exact: true }).click();
    await expect(page.locator("[data-live=doorComparison]")).toHaveText("확인 불가");
    await expect(page.locator("[data-live=doorReason]")).toContainText("기준 거리를 확인해 주세요");
    const saved = JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]);
    await page.getByRole("link", { name: "닫힘 기준 확인·보정", exact: true }).click();
    await page.getByLabel("실제로 문을 닫고 위 기준 거리를 직접 확인했어요.").check(); await saveSettings(page);
    const confirmed = JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]);
    assert.deepEqual(confirmed, { ...saved, intrusion: { ...saved.intrusion, baselineConfirmed: true } });
    await nav(page, "우리 집"); await page.getByRole("link", { name: "가스 센서 상태 상세 보기", exact: true }).click();
    await expect(page.locator(".z-status-primary")).toContainText("농도 미측정 · 화재 위험 판단 불가");
    await expect(page.locator(".z-threshold")).toContainText("미적용");
    await expect(page.locator("[data-live=currentGas]")).toHaveText("120");
    await shot(page, "gas-detail-desktop");
    await nav(page, "우리 집"); await page.getByRole("link", { name: "문 작동 확인 상세 보기", exact: true }).click();
    const commands = await page.evaluate(() => ziponTestUsb.port.writes.map(JSON.parse).filter(p => p.type === "manual").length);
    for (const [distanceCm, label] of [[2, "기준 범위"], [22, "기준 범위"], [22.1, "거리 변화"], [null, "확인 불가"]]) {
      await sample(page, { distanceCm }); await expect(page.locator("[data-live=doorComparison]")).toHaveText(label);
    }
    await expect(page.locator("[data-live=doorDelta]")).toHaveText("—");
    await expect(page.locator("[data-live=doorReason]")).toContainText("초음파 응답이 없어요");
    assert.deepEqual(JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]), confirmed);
    assert.equal(await page.evaluate(() => ziponTestUsb.port.writes.map(JSON.parse).filter(p => p.type === "manual").length), commands);
    await shot(page, "door-detail-desktop"); await sample(page, { distanceCm: 12 }); await nav(page, "홈");
  });
  await checked("LED 2초 시험의 실행 응답과 실제 출력 보고·시간 종료", async () => {
    await expand(page, ".z-control-details");
    await page.locator('[data-action="manual-led-test"]').click();
    await expect(page.locator("[data-live=commandNote]")).toContainText("보드 실행 응답");
    await sample(page); await expect(page.locator("[data-live=ledControl]")).toHaveText("켜짐");
    await expect(page.locator("[data-live=ledControl]")).toHaveText("꺼짐", { timeout: 5000 });
  });
  await checked("부저는 재확인 취소 시 보내지 않고 확인해야 2초 시험", async () => {
    const count = () => page.evaluate(() => ziponTestUsb.port.writes.map(JSON.parse).filter(p => p.type === "manual" && p.target === "buzzer").length);
    const before = await count();
    await page.locator('[data-action="manual-buzzer-test"]').click(); await confirm(page, "취소"); assert.equal(await count(), before);
    await page.locator('[data-action="manual-buzzer-test"]').click(); await confirm(page, "부저 2초 시험");
    await expect.poll(count).toBe(before + 1); await sample(page);
    await expect(page.locator("[data-live=buzzerControl]")).toHaveText("작동");
    await expect(page.locator("[data-live=buzzerControl]")).toHaveText("정지", { timeout: 5000 });
  });
  await checked("이번 연결 가스 감시는 별도 확인·보드 응답 후 보고", async () => {
    await nav(page, "기기 관리");
    assert.equal(await page.evaluate(() => ziponTestUsb.port.state.config), 0);
    await page.getByRole("button", { name: "가스 감시 시작", exact: true }).click(); await confirm(page, "가스 감시 시작");
    await expect.poll(() => page.evaluate(() => ziponTestUsb.port.state.config)).toBeGreaterThan(0);
    await sample(page); await expect(page.locator("[data-live=gasMonitoring]")).toHaveText("보드 감시 중");
  });
  await checked("자동 가스 경보 중 수동 끄기·0 출력으로 경보가 사라지지 않음", async () => {
    await nav(page, "홈");
    await sample(page, { gasRaw: 250, gasAlarm: true, gasState: "alert" });
    await expect(page.locator("[data-alarm]")).toContainText("가스 원시 출력 경고");
    await page.getByRole("button", { name: "수동 LED 끄기", exact: true }).click();
    await sample(page); await expect(page.locator("[data-live=ledControl]")).toHaveText("켜짐");
    await sample(page, { gasRaw: 0, gasState: "fault" });
    await expect(page.locator("[data-alarm]")).toBeVisible();
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.points.at(-1).gas)).toBe(null);
    await sample(page, { gasRaw: 120, gasAlarm: false, gasState: "below" });
    await expect(page.locator("[data-alarm]")).toBeHidden();
  });
  await checked("그래프 개별 숨김·한 개 전체 폭·다시 표시·표 제공", async () => {
    await nav(page, "실시간");
    await page.getByRole("button", { name: "거리 그래프", exact: true }).click();
    await expect(page.locator(".z-chart-card")).toHaveCount(1);
    const widths = await page.locator(".z-chart-card").evaluate(n => [n.clientWidth, n.parentElement.clientWidth]); assert(Math.abs(widths[0] - widths[1]) < 3);
    await page.getByRole("button", { name: "가스 그래프", exact: true }).click(); await expect(page.locator("canvas")).toHaveCount(0);
    await page.getByRole("button", { name: "가스 그래프", exact: true }).click(); await page.getByRole("button", { name: "거리 그래프", exact: true }).click();
    await page.getByText("최근 측정 10개를 표로 보기", { exact: true }).click();
    await expect(page.locator("[data-sample-table] tbody tr")).toHaveCount(10);
    await shot(page, "monitor-connected-desktop");
  });
  await checked("기준 확인 후 출입 의심·실패는 정상 해제가 아닌 요청 종료", async () => {
    await nav(page, "기기 관리");
    await page.getByRole("button", { name: "출입 감시 시작", exact: true }).click(); await confirm(page, "출입 감시 시작");
    await nav(page, "실시간");
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.analysis.normalSeen)).toBe(true);
    await sample(page, { distanceCm: 50 });
    await expect(page.locator("[data-live=intrusionState]")).toHaveText("출입 의심", { timeout: 7000 });
    await expect.poll(() => page.evaluate(() => ziponTestUsb.port.state.intrusionAlarm)).toBe(true);
    await sample(page, { distanceCm: null });
    await expect(page.locator("[data-live=distanceState]")).toHaveText("응답 없음");
    await expect.poll(() => page.evaluate(() => ziponTestUsb.port.state.intrusionAlarm)).toBe(false);
    await sample(page, { distanceCm: 50 });
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.analysis.normalSeen)).toBe(false);
    await nav(page, "기기 관리"); await page.getByRole("button", { name: "출입 감시 종료", exact: true }).click();
  });
  await checked("측정 중단에 지난 보고·제어 잠금·끊기와 새 세션 재연결", async () => {
    await nav(page, "실시간");
    const old = await page.evaluate(() => { ziponTestUsb.port.pause = true; return ziponTestUsb.port.session; });
    await expect(page.locator("[data-live=connectionBadge]")).toHaveText("측정 중단", { timeout: 6000 });
    await expect(page.locator("[data-live=ledValue]")).toContainText("지난 보고");
    await nav(page, "홈"); await expect(page.getByRole("button", { name: /^LED 켜기/ })).toBeDisabled(); await page.getByRole("link", { name: "문 작동 확인 상세 보기", exact: true }).click();
    await expect(page.locator("[data-live=doorComparison]")).toHaveText("확인 불가");
    await expect(page.locator("[data-live=currentDistance]")).toHaveText("—");
    await nav(page, "기기 관리");
    await page.getByRole("button", { name: "연결 해제", exact: true }).click();
    await expect.poll(() => page.evaluate(() => ziponTestUsb.port.closes)).toBe(1);
    await page.evaluate(() => { ziponTestUsb.port.pause = false; ziponTestUsb.port.state.distanceCm = 12; });
    await page.getByRole("button", { name: "다시 연결", exact: true }).click();
    await expect(page.locator("[data-live=connectionBadge]")).toHaveText("연결됨");
    assert.notEqual(await page.evaluate(() => ziponTestUsb.port.session), old);
    assert.equal(await page.evaluate(() => ziponTestUsb.port.opens), 2);
  });
  await checked("이벤트 전송·당시 수치와 출력 저장·기록 조회·종류 필터", async () => {
    await app(page).evaluate(n => n.ziponApp.flush());
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.unsaved.length)).toBe(0);
    assert(dbRead("SELECT COUNT(*) FROM zipon_events")[0][0] > 8);
    const rows = dbRead("SELECT value FROM zipon_events WHERE kind='gas_alert'").map(r => JSON.parse(r[0])); assert.equal(rows[0].gas_raw, 250); assert.equal(rows[0].led, true);
    await nav(page, "기록");
    await expect(page.locator(".z-event-list>li")).not.toHaveCount(0);
    await page.getByLabel("기록 종류", { exact: true }).selectOption("usb");
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.recordResult.rows.every(r => r.kind.startsWith("usb")))).toBe(true);
    await page.getByLabel("기록 종류", { exact: true }).selectOption("all");
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.recordResult.total)).toBeGreaterThan(8);
  });
  await checked("기록 JSON과 설치 ZIP 다운로드에 비밀번호·실행 자료 없음", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "기록 내보내기", exact: true }).click()]);
    const text = await readFile(await download.path(), "utf8"); const value = JSON.parse(text);
    assert.equal(value.format, "zipon-family-v4"); assert.equal(value.settings.homeName, "격리 검사 집"); assert(!text.includes(password)); assert(value.events.length > 8);
    await nav(page, "기기 관리");
    await expand(page, ".z-install-help");
    const [kit] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "V4 설치 묶음 받기", exact: true }).click()]);
    assert.equal(kit.suggestedFilename(), "zipon-usb-v4-kit.zip");
    const names = JSON.parse(execFileSync("python3", ["-B", "-c", "import zipfile,json,sys; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", await kit.path()], { encoding: "utf8" })); assert.equal(names.length, 3);
  });
  await checked("명시적으로 선택한 이전 기록만 가져오고 중복을 덮지 않음", async () => {
    await nav(page, "기록"); await expand(page, ".z-import-panel");
    const data = { format: "zipon-family-v4", events: [{ id: "isolated-imported-once", kind: "door_open", title: "이전 원시 거리 변화", created_at: "2026-01-01T00:00:00.000Z", detail: "격리된 이전 기록", gas_raw: 100, distance_cm: 30, led: false, buzzer: false }] };
    const file = { name: "isolated-history.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) };
    await page.getByLabel("이전 집온 JSON · 2MB 이하, 최대 5,000건").setInputFiles(file);
    await page.getByRole("button", { name: "이전 기록 가져오기", exact: true }).click(); await confirm(page, "기록 가져오기");
    await expect.poll(() => dbRead("SELECT COUNT(*) FROM zipon_events WHERE id='isolated-imported-once'")[0][0]).toBe(1);
    await expect(page.getByLabel("이전 집온 JSON · 2MB 이하, 최대 5,000건")).toHaveValue("");
    await page.getByLabel("이전 집온 JSON · 2MB 이하, 최대 5,000건").setInputFiles(file);
    await page.getByRole("button", { name: "이전 기록 가져오기", exact: true }).click(); await confirm(page, "기록 가져오기");
    await expect(page.locator(".z-toast")).toContainText("0건");
    assert.equal(dbRead("SELECT COUNT(*) FROM zipon_events WHERE id='isolated-imported-once'")[0][0], 1);
    await nav(page, "기록"); await page.getByLabel("날짜", { exact: true }).fill("2026-01-01");
    await expect(page.getByRole("heading", { name: "이전 원시 거리 변화", exact: true })).toBeVisible();
  });
  await checked("잘못된 파일을 새로 고르면 이전 선택 자료를 가져오지 않음", async () => {
    await expand(page, ".z-import-panel");
    const input = page.getByLabel("이전 집온 JSON · 2MB 이하, 최대 5,000건");
    await input.setInputFiles({ name: "isolated-valid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "zipon-family-v4", events: [] })) });
    await expect.poll(() => app(page).evaluate(n => Boolean(n.ziponApp.importData))).toBe(true);
    await input.setInputFiles({ name: "isolated-invalid.json", mimeType: "application/json", buffer: Buffer.from("{invalid}") });
    await page.getByRole("button", { name: "이전 기록 가져오기", exact: true }).click();
    await expect(page.locator(".z-toast")).toContainText("먼저 집온 기록 JSON 파일을 선택해 주세요");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
  const other = await pageFor();
  await checked("다른 접속의 저장 기록·마지막 보고는 조회만 하고 USB 원격 제어 안 함", async () => {
    await other.goto(origin + "?page=monitor"); await unlock(other);
    await expect(other.locator("[data-live=gasValue]")).toHaveText("120");
    await expect(other.locator("[data-live=connectionMessage]")).toContainText("보관된 마지막 보고");
    await nav(other, "홈"); await expect(other.getByRole("button", { name: /^LED 켜기/ })).toBeDisabled();
    assert.equal(await other.evaluate(() => ziponTestUsb.port.opens), 0);
  });
  await checked("다른 접속의 설정 변경과 충돌 시 기존 수정으로 덮어쓰지 않음", async () => {
    await nav(page, "설정"); await section(page, "기본 설정"); await page.getByLabel("집 이름 *", { exact: true }).fill("덮어쓰지 않을 수정");
    await nav(other, "설정"); await other.getByLabel("집 이름 *", { exact: true }).fill("다른 접속의 적용"); await saveSettings(other);
    await expect.poll(() => app(page).evaluate(n => n.ziponApp.settings.homeName)).toBe("다른 접속의 적용");
    await page.getByRole("button", { name: "이번 접속에 적용", exact: true }).click();
    await expect(page.locator("[data-settings-error]")).toContainText("다른 화면에서 설정이 바뀌었어요");
    assert.equal(JSON.parse(dbRead("SELECT value FROM zipon_settings")[0][0]).homeName, "다른 접속의 적용");
    await page.getByRole("button", { name: "수정 취소", exact: true }).click();
    await expect(page.getByLabel("집 이름 *", { exact: true })).toHaveValue("다른 접속의 적용");
  });
  await checked("데스크톱·558·390·320px의 모든 화면에 가로 넘침 없음", async () => {
    for (const width of [1440, 558, 390, 320]) {
      await other.setViewportSize({ width, height: width < 900 ? 844 : 1000 });
      for (const label of ["홈", "실시간", "설정", "안심 시간", "기록", "기기 관리"]) {
        await nav(other, label); await noOverflow(other);
        if (width === 390 && ["실시간", "설정", "안심 시간", "홈"].includes(label)) await shot(other, `mobile-${label}`);
      }
      for (const id of ["gas-status", "door-status"]) {
        await nav(other, "우리 집"); await other.locator(`.z-status-card[data-page="${id}"]`).click(); await noOverflow(other);
        if (width === 390) await shot(other, `mobile-${id}`);
      }
    }
  });
  await checked("터치 화면에서도 설정 입력·하단 메뉴·44px 동작 버튼 제공", async () => {
    const touch = await pageFor(390, 844); await touch.goto(origin + "?page=monitor"); await unlock(touch);
    assert.equal(await touch.evaluate(() => matchMedia("(pointer:coarse)").matches), true);
    for (const label of ["홈", "실시간", "설정", "안심 시간", "기록", "기기 관리"]) { await nav(touch, label); await noOverflow(touch); }
    await nav(touch, "안심 시간");
    assert(await touch.getByRole("button", { name: "+ 안심 시간 추가", exact: true }).evaluate(n => n.getBoundingClientRect().height >= 44));
    await shot(touch, "mobile-touch-settings"); await touch.close();
  });
  await checked("지원하지 않는 브라우저 안내와 USB 버튼 잠금", async () => {
    const unsupported = await pageFor(390, 844, false); await unsupported.goto(origin + "?page=monitor"); await unlock(unsupported);
    await nav(unsupported, "기기 관리");
    await expect(unsupported.getByRole("button", { name: "USB 연결", exact: true })).toBeDisabled();
    await expect(unsupported.locator("[data-live=connectionMessage]")).toContainText("지원하지 않아요");
    await unsupported.close();
  });
  await checked("가족 공간 닫기로 USB 정리·다시 열어도 저장한 기록 유지", async () => {
    await page.getByRole("button", { name: "가족 공간", exact: true }).click(); await confirm(page, "가족 공간 닫기");
    await expect(page.getByRole("heading", { name: "우리 가족의 공간이에요" })).toBeVisible();
    await expect(app(page)).toHaveCount(0);
    assert.equal(await page.evaluate(() => ziponTestUsb.port.opened), false);
    await unlock(page); assert.equal(dbRead("SELECT COUNT(*) FROM zipon_events WHERE id='isolated-imported-once'")[0][0], 1);
  });
  await checked("3초 지연 중에도 첫 로딩 안내·메뉴 반응·화면 선명도 유지", async () => {
    await writeFile(latency, "slow");
    const slow = activePage = await pageFor(558, 760);
    await slow.goto(origin + "?page=monitor");
    await slow.getByLabel("가족 비밀번호", { exact: true }).fill(password);
    await slow.getByRole("button", { name: "가족 공간 열기", exact: true }).click();
    await expect(slow.getByText(/집온 · 저장된 설정과 기록을 불러오고 있어요/)).toBeVisible({ timeout: 2500 });
    await app(slow).waitFor();
    await app(slow).evaluate(root => {
      window.ziponDimSamples = [];
      window.ziponDimTimer = setInterval(() => {
        let faded = false;
        for (let n = root; n; n = n.parentElement || n.getRootNode()?.host) {
          if (n instanceof Element && Number(getComputedStyle(n).opacity) < 0.99) faded = true;
        }
        ziponDimSamples.push(faded);
      }, 40);
    });
    const started = performance.now();
    await nav(slow, "설정");
    await expect(slow.getByLabel("집 이름 *", { exact: true })).toBeVisible();
    const navigationMs = performance.now() - started;
    assert(navigationMs < 1500, `지연 중 메뉴 반응 ${navigationMs}ms`);
    await slow.waitForTimeout(6500);
    assert.equal(await slow.evaluate(() => { clearInterval(ziponDimTimer); return ziponDimSamples.some(Boolean); }), false);
    console.log(`측정 · 저장 조회 3초 지연 중 메뉴 전환 ${Math.round(navigationMs)}ms · 흐림 관찰 0회`);
    await shot(slow, "slow-storage-mobile");
    await writeFile(latency, ""); await slow.close(); activePage = page;
  });
  await checked("저장 조회 실패에도 마지막 화면·오류 안내 유지·비밀 오류 미노출", async () => {
    await writeFile(latency, "fail");
    await expect(page.getByText(/저장 연결을 확인하지 못했어요/)).toBeVisible({ timeout: 15000 });
    await expect(app(page)).toHaveCount(1);
    await nav(page, "실시간");
    await expect(page.getByRole("heading", { name: "실시간 측정값", exact: true })).toBeVisible();
    assert(!(await page.locator("body").innerText()).includes("isolated-storage-failure"));
    await shot(page, "storage-failure-desktop");
    await writeFile(latency, "");
    await expect(page.getByText(/저장 연결을 확인하지 못했어요/)).toHaveCount(0, { timeout: 15000 });
  });
  assert.deepEqual(errors, [], "브라우저 오류가 없어야 해요");
  console.log(`Streamlit 브라우저 격리 검사 ${checks}개 통과 (가상 USB, 실물 시험 아님)`);
} catch (error) {
  if (activePage && !activePage.isClosed()) await shot(activePage, "failure").catch(() => {});
  if (activePage && !activePage.isClosed()) {
    const diagnostic = await app(activePage).evaluate(root => {
      const a = root.ziponApp;
      return { page: a.page, connection: a.connection, lease: a.lease, backendAgeMs: Math.round(performance.now() - a.lastBackend), saveError: a.saveError, pending: a.pendingRequest?.op, unsaved: a.unsaved.length, usb: { ready: a.usb.ready, opening: a.usb.opening, closing: Boolean(a.usb.closing), port: Boolean(a.usb.port), fresh: a.usb.fresh, protocolError: a.usb.lastProtocolError }, fake: { opens: ziponTestUsb.port.opens, closes: ziponTestUsb.port.closes, pause: ziponTestUsb.port.pause, state: ziponTestUsb.port.state }, toast: root.querySelector(".z-toast").textContent };
    }).catch(() => null);
    if (diagnostic) console.error(JSON.stringify(diagnostic));
  }
  console.error(error.message); if (errors.length) console.error(JSON.stringify(errors)); process.exitCode = 1;
} finally {
  await browser?.close();
  try { execFileSync("stop-bg", [log], { stdio: "pipe" }); } catch { /* startup already failed */ }
}
