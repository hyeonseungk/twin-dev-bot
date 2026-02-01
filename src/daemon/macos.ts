import { execSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { getHomeDir } from "../core/platform.js";
import { LOG_OUT, LOG_ERR } from "../core/paths.js";
import { t } from "../i18n/index.js";
import type { DaemonManager } from "./types.js";

const LABEL = "com.twin-dev-bot";
const PLIST_DIR = join(getHomeDir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const GUI_DOMAIN = `gui/${process.getuid!()}`;

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
}

function getTwindevbotPath(): string {
  try {
    return execSync("which twindevbot", { encoding: "utf-8" }).trim();
  } catch {
    return process.argv[1];
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildPlist(): string {
  const nodePath = getNodePath();
  const cliPath = getTwindevbotPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(nodePath)}</string>
        <string>${escapeXml(cliPath)}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${escapeXml(process.cwd())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(process.env.PATH ?? "")}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(LOG_OUT)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(LOG_ERR)}</string>
</dict>
</plist>`;
}

export class MacOSDaemonManager implements DaemonManager {
  start(): void {
    if (!existsSync(PLIST_DIR)) {
      mkdirSync(PLIST_DIR, { recursive: true });
    }

    // plist 파일 유무와 관계없이 항상 bootout 시도 (수동 삭제된 경우 대비)
    try {
      execSync(`launchctl bootout ${GUI_DOMAIN}/${LABEL}`, { stdio: "ignore" });
    } catch {
      // 등록되어 있지 않으면 무시
    }

    const plist = buildPlist();
    writeFileSync(PLIST_PATH, plist);
    console.log(t("cli.daemon.plistCreated", { path: PLIST_PATH }));

    try {
      execSync(`launchctl bootstrap ${GUI_DOMAIN} "${PLIST_PATH}"`);
      console.log(t("cli.daemon.started"));
      console.log("");
      console.log(`  Status:  twindevbot status`);
      console.log(`  Stop:    twindevbot stop`);
      console.log(`  Logs:    ${this.getLogViewCommand(LOG_ERR)}`);
    } catch (err) {
      console.error(t("cli.daemon.failedToStart"), err);
      process.exit(1);
    }
  }

  stop(): void {
    if (!existsSync(PLIST_PATH)) {
      console.log(t("cli.daemon.notInstalled"));
      return;
    }

    try {
      execSync(`launchctl bootout ${GUI_DOMAIN}/${LABEL}`);
    } catch {
      // 이미 중지되어 있을 수 있음
    }

    unlinkSync(PLIST_PATH);
    console.log(t("cli.daemon.stopped"));
  }

  status(): void {
    if (!existsSync(PLIST_PATH)) {
      console.log(t("cli.status.notInstalled"));
      console.log(t("cli.status.notInstalledHint"));
      return;
    }

    try {
      const output = execSync(`launchctl list "${LABEL}"`, {
        encoding: "utf-8",
      });

      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) {
        console.log(t("cli.status.running", { pid: pidMatch[1] }));
      } else {
        console.log(t("cli.status.registered"));
      }

      console.log(`  Logs: ${this.getLogViewCommand(LOG_ERR)}`);
    } catch {
      console.log(t("cli.status.notRunning"));
      console.log(t("cli.status.checkLogs"));
      console.log(`  tail -50 "${LOG_ERR}"`);
    }
  }

  isRunning(): boolean {
    if (!existsSync(PLIST_PATH)) return false;
    try {
      const output = execSync(`launchctl list "${LABEL}"`, { encoding: "utf-8" });
      return !!output.match(/"PID"\s*=\s*(\d+)/);
    } catch {
      return false;
    }
  }

  getLogViewCommand(logPath: string): string {
    return `tail -f "${logPath}"`;
  }
}
