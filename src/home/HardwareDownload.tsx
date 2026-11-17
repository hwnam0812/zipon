import { useEffect, useState } from "react";

const filename = "zipon-mq135-usb-kit.zip";

export default function HardwareDownload() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let active = true;
    let objectUrl = "";

    async function prepare() {
      try {
        // Fetch within the preview session instead of sending the browser's
        // download process to a preview-protected HTTP address.
        const response = await fetch(`/downloads/${filename}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("download unavailable");
        const bytes = new Uint8Array(await response.arrayBuffer());
        // A proxy/error page may return HTML with HTTP 200. Never save it as ZIP.
        if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
          throw new Error("invalid zip");
        }
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
        setUrl(objectUrl);
      } catch {
        if (active) setError("파일을 준비하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void prepare();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
      // Leave time for an in-progress download when the owner changes pages.
      if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    };
  }, [attempt]);

  return <>
    {url ? <a className="primary-button" href={url} download={filename}>아두이노 코드·연결 안내 받기</a> :
      <button className="primary-button" type="button" disabled={!error} aria-busy={!error}
        aria-describedby={error ? "hardware-download-error" : undefined}
        onClick={() => { setError(""); setAttempt(value => value + 1); }}>
        {error ? "파일 준비 다시 시도" : "파일 준비 중…"}
      </button>}
    {error && <p id="hardware-download-error" className="field-error" role="alert">{error}</p>}
  </>;
}
