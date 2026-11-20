// Only these public source/guide files are packaged. Never include environments,
// local state, test data, attachments, build caches or credentials.
import { mkdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync("public/downloads", { recursive: true });
mkdirSync(".baze-files/outputs", { recursive: true });
execFileSync("python3", ["-c", `
from zipfile import ZipFile, ZIP_DEFLATED
from pathlib import Path
names = ['zipon_uno/zipon_uno.ino', 'bridge.py', 'requirements.txt', 'MQ135-설치안내.md', 'zipon-mq135-wiring.svg']
with ZipFile('public/downloads/zipon-mq135-usb-kit.zip', 'w', ZIP_DEFLATED, strict_timestamps=False) as z:
    for name in names:
        z.write(Path('hardware') / name, 'zipon-mq135-usb-kit/' + name)
`]);
for (const name of ["zipon-mq135-usb-kit.zip", "zipon-usb-kit.zip"]) {
  copyFileSync("public/downloads/zipon-mq135-usb-kit.zip", `.baze-files/outputs/${name}`);
}
copyFileSync("public/downloads/zipon-mq135-usb-kit.zip", "public/downloads/zipon-usb-kit.zip");
copyFileSync("hardware/zipon-mq135-wiring.svg", "public/downloads/zipon-mq135-wiring.svg");
copyFileSync("hardware/zipon-mq135-wiring.svg", ".baze-files/outputs/zipon-mq135-wiring.svg");
copyFileSync("hardware/zipon_uno/zipon_uno.ino", ".baze-files/outputs/zipon_uno.ino");
copyFileSync("hardware/MQ135-설치안내.md", ".baze-files/outputs/MQ135-설치안내.md");
copyFileSync("hardware/ultrasonic_photo_check/ultrasonic_photo_check.ino", ".baze-files/outputs/ultrasonic_photo_check.ino");
copyFileSync("hardware/사진배선-초음파검사.md", ".baze-files/outputs/사진배선-초음파검사.md");
console.log("USB 코드와 설치 안내 묶음을 만들었어요.");
