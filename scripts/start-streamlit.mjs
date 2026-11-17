// Streamlit is an internal backend of the single-port development preview.
// Toolchains and runtime data must never be saved in the source workspace.
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const env = { ...process.env, UV_PROJECT_ENVIRONMENT: join(homedir(), ".cache", "zipon-streamlit-venv"), PYTHONDONTWRITEBYTECODE: "1", ZIPON_DEV_DB: join(tmpdir(), "zipon-streamlit-preview.sqlite") };
const p = spawn("uv", ["run", "--frozen", "streamlit", "run", "streamlit_app.py", "--server.address", "0.0.0.0", "--server.port", "8501", "--server.baseUrlPath", "streamlit", "--server.headless", "true"], { env, stdio: "inherit" });
process.on("SIGTERM", () => p.kill("SIGTERM"));
process.on("SIGINT", () => p.kill("SIGINT"));
p.on("exit", code => process.exit(code ?? 0));
