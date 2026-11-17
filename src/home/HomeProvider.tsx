import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HomeSettings, HomeSnapshot, OutputAction, OutputTarget } from "../lib/home-model";

type Toast = { text: string; tone: "success" | "error" | "info" } | null;
type ReceivedSnapshot = HomeSnapshot & { measurementExpiresAt: number };
type HomeContextValue = {
  state: {
    snapshot: HomeSnapshot | null; authenticated: boolean; configured: boolean | null; accessError: string;
    loading: boolean; error: string; pending: string;
    toast: Toast; browserEnabled: boolean; permission: NotificationPermission | "unsupported";
  };
  actions: {
    request: <T>(path: string, init?: RequestInit) => Promise<T>;
    refresh: () => Promise<void>; saveSettings: (settings: HomeSettings) => Promise<void>;
    siren: (action: "start" | "stop") => Promise<void>; readAlerts: (ids: string[]) => Promise<void>;
    output: (target: OutputTarget, action: OutputAction) => Promise<void>;
    unlock: (password: string) => Promise<void>; leave: () => void;
    checkAccess: () => Promise<void>; browserNotifications: () => Promise<void>;
    notify: (text: string, tone?: "success" | "error" | "info") => void;
  };
};
const HomeContext = createContext<HomeContextValue | null>(null);
function stored(storage: "localStorage" | "sessionStorage", key: string) {
  try { return window[storage].getItem(key) ?? ""; } catch { return ""; }
}
function keep(storage: "localStorage" | "sessionStorage", key: string, value: string) {
  try { if (value) window[storage].setItem(key, value); else window[storage].removeItem(key); } catch { /* Private browsing can disallow storage. */ }
}
class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function jsonRequest<T>(path: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/home${path}`, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), headers: { "content-type": "application/json", ...headers, ...init.headers } }); }
  catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("연결이 끊겼어요. 집의 현재 상태를 확인할 수 없으니 인터넷 연결을 확인해 주세요.");
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error("집의 소식을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new RequestError(data.error ?? "요청을 처리하지 못했어요. 다시 시도해 주세요.", response.status);
  return data;
}

export function HomeProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => stored("sessionStorage", "zipon-family"));
  const [configured, setConfigured] = useState<boolean | null>(null), [accessError, setAccessError] = useState("");
  const [snapshot, setSnapshot] = useState<ReceivedSnapshot | null>(null);
  const [measurementFresh, setMeasurementFresh] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [pending, setPending] = useState(""), [toast, setToast] = useState<Toast>(null);
  const [browserEnabled, setBrowserEnabled] = useState(() => stored("localStorage", "zipon-browser-alerts") === "yes");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => "Notification" in window ? Notification.permission : "unsupported");
  const seenAlerts = useRef<Set<string> | null>(null);
  const mutationVersion = useRef(0), operationInFlight = useRef(false);
  const identity = token;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const headers = useMemo(() => {
    return { authorization: `Bearer ${encodeURIComponent(token)}` };
  }, [token]);
  const closeFamily = useCallback((message = "") => {
    keep("sessionStorage", "zipon-family", "");
    identityRef.current = "";
    setToken(""); setSnapshot(null); setLoading(false); setError(""); setAccessError(message);
    seenAlerts.current = null;
  }, []);
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}) => {
    if (!token) throw new RequestError("가족 비밀번호로 공간을 먼저 열어 주세요.", 401);
    if (init.method && init.method !== "GET") mutationVersion.current++;
    try { return await jsonRequest<T>(path, headers, init); }
    catch (e) {
      if (e instanceof RequestError && e.status === 401 && identityRef.current === token) closeFamily("가족 공간이 잠겼어요. 비밀번호를 다시 입력해 주세요.");
      throw e;
    }
  }, [headers, token, closeFamily]);
  const notify = useCallback((text: string, tone: "success" | "error" | "info" = "success") => setToast({ text, tone }), []);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 5500); return () => window.clearTimeout(t); }, [toast]);

  const apply = useCallback((next: HomeSnapshot, origin: string, requestedAt: number) => {
    if (identityRef.current !== origin) return;
    // Count the whole request's transit time conservatively. A delayed response
    // or repeated lastSeen must never give an old measurement a fresh lifetime.
    const age = next.sensor.lastSeen ? Date.parse(next.serverTime) - Date.parse(next.sensor.lastSeen) : Infinity;
    const expiresAt = Number.isFinite(age) ? requestedAt + Math.max(0, 15000 - Math.max(0, age)) : 0;
    setSnapshot(old => old && old.serverTime > next.serverTime ? old : {
      ...next,
      measurementExpiresAt: old && old.sensor.lastSeen === next.sensor.lastSeen ? Math.min(old.measurementExpiresAt, expiresAt) : expiresAt,
    });
    setError(""); setLoading(false);
  }, []);
  useEffect(() => {
    const remaining = (snapshot?.measurementExpiresAt ?? 0) - performance.now();
    setMeasurementFresh(Boolean(snapshot?.online && remaining > 0));
    if (remaining <= 0 || !Number.isFinite(remaining)) return;
    const timer = window.setTimeout(() => setMeasurementFresh(false), remaining);
    return () => window.clearTimeout(timer);
  }, [snapshot?.online, snapshot?.measurementExpiresAt]);
  const refresh = useCallback(async () => {
    if (!identity) return;
    const origin = identity;
    const version = mutationVersion.current, requestedAt = performance.now();
    try { const next = await request<HomeSnapshot>("/snapshot"); if (mutationVersion.current === version) apply(next, origin, requestedAt); }
    catch (e) { if (identityRef.current === origin) { setError((e as Error).message); setLoading(false); } }
  }, [request, apply, identity]);

  const checkAccess = useCallback(async () => {
    setAccessError("");
    try {
      const result = await jsonRequest<{ configured: boolean }>("/access", {});
      setConfigured(result.configured);
    } catch (e) { setAccessError((e as Error).message); }
  }, []);
  useEffect(() => { if (!token) void checkAccess(); }, [token, checkAccess]);

  useEffect(() => {
    if (!identity) { setSnapshot(null); setLoading(false); return; }
    const controller = new AbortController();
    const origin = identity;
    let inFlight = false;
    setSnapshot(null); setLoading(true); setError(""); seenAlerts.current = null;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const version = mutationVersion.current, requestedAt = performance.now();
      try {
        const next = await request<HomeSnapshot>("/snapshot", { signal: controller.signal });
        if (!controller.signal.aborted && mutationVersion.current === version) apply(next, origin, requestedAt);
      } catch (e) {
        if (!controller.signal.aborted && identityRef.current === origin) { setError((e as Error).message); setLoading(false); }
      } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [request, apply, identity]);

  useEffect(() => {
    if (!snapshot) return;
    const ids = new Set(snapshot.alerts.map(a => a.id));
    if (seenAlerts.current) {
      const fresh = snapshot.alerts.filter(a => !seenAlerts.current!.has(a.id) && !a.read_at);
      if (fresh.length) {
        const alert = fresh[0];
        notify(alert.title, "info");
        if (browserEnabled && "Notification" in window && Notification.permission === "granted") {
          try { new Notification(`집온 · ${alert.title}`, { body: alert.message, tag: alert.id }); }
          catch { /* Some mobile browsers only support service-worker notifications. The in-app alert remains saved. */ }
        }
      }
    }
    seenAlerts.current = ids;
  }, [snapshot, browserEnabled, notify]);

  const run = useCallback(async (name: string, work: () => Promise<void>) => {
    if (operationInFlight.current) { const error = new Error("이전 요청을 처리하고 있어요. 잠시 뒤 다시 눌러 주세요."); notify(error.message, "info"); throw error; }
    operationInFlight.current = true;
    setPending(name);
    try { await work(); }
    catch (e) { notify((e as Error).message, "error"); throw e; }
    finally { operationInFlight.current = false; setPending(""); }
  }, [notify]);
  const saveSettings = useCallback((settings: HomeSettings) => run("settings", async () => {
    const requestedAt = performance.now();
    const next = await request<HomeSnapshot>("/settings", { method: "PUT", body: JSON.stringify(settings) });
    apply(next, identity, requestedAt);
    notify("우리 집 설정을 저장했어요.");
  }), [run, request, apply, notify, identity]);
  const siren = useCallback((action: "start" | "stop") => run("siren", async () => {
    const requestedAt = performance.now();
    const next = await request<HomeSnapshot>("/commands", { method: "POST", body: JSON.stringify({ action, id: crypto.randomUUID() }) });
    apply(next, identity, requestedAt);
    notify(action === "start" ? "집에 사이렌을 요청했어요. 기기의 실행 응답을 기다려 주세요." : "중지를 요청했어요. 기기의 중지 응답을 기다려 주세요.");
  }), [run, request, apply, notify, identity]);
  const output = useCallback((target: OutputTarget, action: OutputAction) => run(`output-${target}`, async () => {
    const requestedAt = performance.now();
    const next = await request<HomeSnapshot>("/outputs", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), target, action }) });
    apply(next, identity, requestedAt);
    notify("제어를 요청했어요. 현재 출력과 보드 실행 응답을 따로 확인해 주세요.", "info");
  }), [run, request, apply, notify, identity]);
  const readAlerts = useCallback((ids: string[]) => run("alerts", async () => {
    await request("/alerts/read", { method: "PATCH", body: JSON.stringify({ ids }) }); await refresh();
  }), [run, request, refresh]);
  const unlock = useCallback(async (password: string) => {
    await jsonRequest("/unlock", { authorization: `Bearer ${encodeURIComponent(password)}` }, { method: "POST" });
    keep("sessionStorage", "zipon-family", password);
    identityRef.current = password;
    setSnapshot(null); setLoading(true); setToken(password); setAccessError(""); setConfigured(true);
    notify("우리 가족 공간을 열었어요.");
  }, [notify]);
  const leave = useCallback(() => {
    closeFamily(); setToast(null);
  }, [closeFamily]);
  const browserNotifications = useCallback(async () => {
    if (!("Notification" in window)) { notify("이 브라우저에서는 화면 안 알림을 확인해 주세요.", "info"); return; }
    if (browserEnabled) { setBrowserEnabled(false); keep("localStorage", "zipon-browser-alerts", ""); return; }
    const result = await Notification.requestPermission(); setPermission(result);
    if (result === "granted") {
      try {
        const check = new Notification("집온 알림을 켰어요", { body: "화면이 열려 있는 동안 새 감지 알림을 전해드려요." });
        window.setTimeout(() => check.close(), 5000);
        setBrowserEnabled(true); keep("localStorage", "zipon-browser-alerts", "yes");
      } catch { setBrowserEnabled(false); notify("이 브라우저에서는 별도 알림을 띄울 수 없어요. 화면 안 알림을 확인해 주세요.", "info"); }
    } else notify("알림이 허용되지 않았어요. 화면 안에서는 계속 알림을 확인할 수 있어요.", "info");
  }, [browserEnabled, notify]);

  const value: HomeContextValue = {
    state: { snapshot: snapshot ? { ...snapshot, online: snapshot.online && measurementFresh } : null, authenticated: Boolean(token), configured, accessError, loading, error, pending, toast, browserEnabled, permission },
    actions: { request, refresh, saveSettings, siren, output, readAlerts, unlock, leave, notify, browserNotifications, checkAccess },
  };
  return <HomeContext value={value}>{children}</HomeContext>;
}
export function useHome() {
  const context = use(HomeContext);
  if (!context) throw new Error("HomeProvider가 필요해요.");
  return context;
}
