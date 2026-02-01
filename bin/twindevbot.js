#!/usr/bin/env node
import { execSync, execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const entry = join(projectRoot, "dist", "cli.js");

// start, help 명령만 빌드 (stop, status는 기존 dist 사용)
const cmd = process.argv[2];
if (!cmd || cmd === "start" || cmd === "help" || cmd === "--help" || cmd === "-h") {
  try {
    execSync("npx tsc", { cwd: projectRoot, stdio: "inherit" });
  } catch {
    // noEmitOnError 미설정 → dist/ 파일은 갱신됨
  }
}
execFileSync(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
});
