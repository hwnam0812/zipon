// Isolated, short-lived test storage. No preview or published family rows are used.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const toolRequire = createRequire(import.meta.resolve("wrangler"));
const { build } = toolRequire("esbuild");
const { Miniflare, Log, LogLevel } = toolRequire("miniflare");
let bundled;

export async function createHomeHarness({ configured = true } = {}) {
  bundled ??= build({ entryPoints: [resolve("worker/index.ts")], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent" });
  const result = await bundled;
  const password = crypto.randomUUID();
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "zipon-test", compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": { type: "esm", contents: result.outputFiles[0].text } } },
      env: { DB: { type: "d1", id: "zipon-test" }, ...(configured ? { ADMIN_TOKEN: { type: "text", value: password } } : {}) },
    }, dev: { stripCfConnectingIp: false } }],
    telemetry: { enabled: false }, log: new Log(LogLevel.ERROR),
  });
  try {
    const db = await runtime.getD1Database("DB");
    const schema = (await readFile("schema.sql", "utf8")).replace(/--[^\n]*/g, "");
    await db.batch(schema.split(";").filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    const familyHeaders = { authorization: `Bearer ${encodeURIComponent(password)}` };
    const fetch = (path, init = {}) => runtime.dispatchFetch(`https://home.test${path}`, init);
    const family = (path, init = {}) => fetch(`/api/home${path}`, { ...init, headers: { "content-type": "application/json", ...familyHeaders, ...init.headers } });
    return { runtime, db, password, fetch, family, familyHeaders, close: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}
