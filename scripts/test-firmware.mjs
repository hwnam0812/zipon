import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const folder = join(tmpdir(), "opencode", "zipon-firmware-test");
mkdirSync(folder, { recursive: true });
const binary = join(folder, "firmware-test");
execFileSync("g++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-Itest/uno-stubs", "test/firmware-native.cpp", "-o", binary], { stdio: "inherit" });
execFileSync(binary, [], { stdio: "inherit" });
