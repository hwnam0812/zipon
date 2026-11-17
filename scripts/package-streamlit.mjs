// Explicit public-source allowlist. Never include runtime state, uploads or secrets.
import { execFileSync } from "node:child_process";
// Rebuild the original app's public downloads from its five reviewed source files.
// These explicit assets must travel with the preserved V3 app as well.
execFileSync(process.execPath, ["scripts/package-hardware.mjs"], { stdio: "inherit" });
execFileSync("python3", ["-B", "-c", `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from io import BytesIO
import shutil
root = Path('.')
out = root / '.baze-files/outputs'
out.mkdir(parents=True, exist_ok=True)
kit = ['hardware/zipon_uno_v4/zipon_uno_v4.ino', 'hardware/zipon-v4-wiring.svg', 'hardware/V4-USB-설치안내.md']
with ZipFile(out / 'zipon-usb-v4-kit.zip', 'w', ZIP_DEFLATED, strict_timestamps=False) as z:
    for name in kit:
        z.write(name, 'zipon-usb-v4/' + str(Path(name).relative_to('hardware')))
for name in kit:
    shutil.copyfile(name, out / Path(name).name)
shutil.copyfile('STREAMLIT-배포안내.md', out / 'STREAMLIT-배포안내.md')
files = set()
top = ['README.md', 'DESIGN.md', 'streamlit_app.py', 'pyproject.toml', 'uv.lock', 'requirements.txt', 'STREAMLIT-배포안내.md', '.streamlit/config.toml', '.gitignore', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'schema.sql', 'wrangler.jsonc', 'baze.json', 'AGENTS.md']
for name in top:
    if Path(name).is_file(): files.add(Path(name))
for name in root.glob('tsconfig*.json'): files.add(name)
allowed = {'.py', '.mjs', '.js', '.css', '.ts', '.tsx', '.ino', '.svg', '.md', '.h', '.cpp', '.json', '.txt', '.png', '.jpg', '.ico'}
for folder in ['zipon_streamlit', 'streamlit_ui', 'hardware', 'src', 'worker', 'scripts', 'test', 'public']:
    for p in (root / folder).rglob('*'):
        if not p.is_file() or p.suffix not in allowed: continue
        if any(part in {'__pycache__', 'node_modules', '.venv', '.git', 'dist', 'outputs', 'uploads', 'downloads'} for part in p.parts): continue
        if p.name.startswith('.env') or 'secrets.toml' in p.name: continue
        files.add(p)
for p in (root / '.github/workflows').glob('*.yml'):
    files.add(p)
for name in ['zipon-mq135-usb-kit.zip', 'zipon-usb-kit.zip', 'zipon-mq135-wiring.svg']:
    files.add(root / 'public/downloads' / name)
archive = BytesIO()
with ZipFile(archive, 'w', ZIP_DEFLATED, strict_timestamps=False) as z:
    for p in sorted(files): z.write(p, 'zipon-streamlit/' + p.as_posix())
(out / 'zipon-streamlit-source.zip').write_bytes(archive.getvalue())
print('Streamlit 공개 소스·V4 설치 묶음:', len(files), '개 파일. 비밀·측정 기록·실행 상태는 제외했어요.')
`], { stdio: "inherit" });
