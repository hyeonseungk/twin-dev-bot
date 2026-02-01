#!/usr/bin/env node

import dotenv from "dotenv";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { confirm } from "@inquirer/prompts";
import { ENV_FILE, LOG_ERR, SESSIONS_FILE, WORKSPACES_FILE, ensureDirs } from "./core/paths.js";
import { initLocale, t } from "./i18n/index.js";
import { ensureConfig } from "./setup.js";
import { isDaemonSupported } from "./core/platform.js";
import { createDaemonManager } from "./daemon/index.js";
import { getDisplayWidth } from "./utils/display-width.js";

// .env 로드 → locale 초기화
dotenv.config({ path: ENV_FILE, override: true });
initLocale();

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;

  for (const word of words) {
    const wordWidth = getDisplayWidth(word);
    const gap = line ? 1 : 0;
    if (lineWidth + gap + wordWidth > maxWidth && line) {
      lines.push(line);
      line = word;
      lineWidth = wordWidth;
    } else {
      line = line ? line + " " + word : word;
      lineWidth += gap + wordWidth;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildWarningBox(text: string, innerWidth: number): string {
  const red = "\x1b[31m";
  const reset = "\x1b[0m";

  const lines = wrapText(text, innerWidth);
  const border = "─".repeat(innerWidth + 2);
  const top = `  ${red}┌${border}┐${reset}`;
  const bottom = `  ${red}└${border}┘${reset}`;
  const empty = `  ${red}│${" ".repeat(innerWidth + 2)}│${reset}`;

  const content = lines.map((l) => {
    const pad = innerWidth - getDisplayWidth(l);
    return `  ${red}│ ${l}${" ".repeat(pad)} │${reset}`;
  });

  return [
    "",
    `  ${red}${t("cli.warning.title")}${reset}`,
    top,
    empty,
    ...content,
    empty,
    bottom,
  ].join("\n");
}

function getLogViewHint(): string {
  if (process.platform === "win32") {
    return `Get-Content "${LOG_ERR}" -Wait`;
  }
  return `tail -f "${LOG_ERR}"`;
}

function printHelp(): void {
  console.log(`
twindevbot - ${t("cli.description")}

${t("cli.usage")}
  twindevbot <command> [options]

${t("cli.commands")}
  start               ${t("cli.cmd.start")}
  start --daemon, -d  ${t("cli.cmd.startDaemon")}
  stop                ${t("cli.cmd.stop")}
  status              ${t("cli.cmd.status")}
  show                ${t("cli.cmd.show")}
  clear               ${t("cli.cmd.clear")}
  help                ${t("cli.cmd.help")}

${t("cli.notes")}
  1. ${t("cli.notes.daemon")}
  2. ${t("cli.notes.errorLog")}
     ${LOG_ERR}
${buildWarningBox(t("cli.warning.text"), 62)}
`);
}

function ensureDaemonSupported(): void {
  if (!isDaemonSupported()) {
    console.error(t("cli.daemonUnsupportedPlatform", { platform: process.platform }));
    process.exit(1);
  }
}

async function startDaemon(): Promise<void> {
  ensureDaemonSupported();
  const manager = await createDaemonManager();
  manager.start();
}

async function stopDaemon(): Promise<void> {
  ensureDaemonSupported();
  const manager = await createDaemonManager();
  manager.stop();
}

async function showStatus(): Promise<void> {
  ensureDaemonSupported();
  const manager = await createDaemonManager();
  manager.status();
}

// ── show command ──────────────────────────────────────────────

interface SerializedSession {
  sessionId: string;
  projectName: string;
  directory: string;
  slackChannelId: string;
  slackThreadTs: string;
  startedAt: string;
  lastActivityAt: string;
  autopilot?: boolean;
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return t("cli.show.daysAgo", { n: days });
  if (hours > 0) return t("cli.show.hoursAgo", { n: hours });
  if (minutes > 0) return t("cli.show.minutesAgo", { n: minutes });
  return t("cli.show.justNow");
}

function showSessions(): void {
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";
  const green = "\x1b[32m";
  const magenta = "\x1b[35m";
  const rst = "\x1b[0m";

  if (!existsSync(SESSIONS_FILE)) {
    console.log(`\n  ${t("cli.show.noSessions")}\n`);
    return;
  }

  let data: { version: number; sessions: SerializedSession[] };
  try {
    data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    console.error(`\n  ${t("cli.show.parseError")}\n`);
    return;
  }

  if (!data.sessions || data.sessions.length === 0) {
    console.log(`\n  ${t("cli.show.noSessions")}\n`);
    return;
  }

  // group by projectName
  const grouped = new Map<string, SerializedSession[]>();
  for (const s of data.sessions) {
    const arr = grouped.get(s.projectName) || [];
    arr.push(s);
    grouped.set(s.projectName, arr);
  }

  // header box
  const total = data.sessions.length;
  const title = t("cli.show.title", { count: total });
  const titleWidth = getDisplayWidth(title);
  const innerWidth = Math.max(titleWidth + 4, 38);
  const padLeft = Math.floor((innerWidth - titleWidth) / 2);
  const padRight = innerWidth - titleWidth - padLeft;

  console.log("");
  console.log(`  ${dim}┌${"─".repeat(innerWidth)}┐${rst}`);
  console.log(`  ${dim}│${rst}${" ".repeat(padLeft)}${bold}${title}${rst}${" ".repeat(padRight)}${dim}│${rst}`);
  console.log(`  ${dim}└${"─".repeat(innerWidth)}┘${rst}`);

  for (const [projectName, sessions] of grouped) {
    const countLabel = t("cli.show.sessionCount", { count: sessions.length });
    console.log("");
    console.log(`  ${bold}${cyan}${projectName}${rst}  ${dim}${countLabel}${rst}`);

    sessions.forEach((s, i) => {
      const isLast = i === sessions.length - 1;
      const prefix = isLast ? "└─" : "├─";
      const sid = s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + "…" : s.sessionId;
      const started = formatDateTime(s.startedAt);
      const lastAct = formatRelativeTime(s.lastActivityAt);
      const autopilotBadge = s.autopilot ? `  ${magenta}autopilot${rst}` : "";
      console.log(
        `  ${dim}${prefix}${rst} ${yellow}${sid}${rst}  ${dim}${started}${rst}  ${green}${lastAct}${rst}${autopilotBadge}`
      );
    });
  }

  console.log("");
}

// ── clear command ─────────────────────────────────────────────

async function clearData(): Promise<void> {
  // 데몬이 실행 중이면 경고
  if (isDaemonSupported()) {
    try {
      const manager = await createDaemonManager();
      if (manager.isRunning()) {
        console.log(`\n  ${t("cli.clear.daemonRunning")}\n`);
        return;
      }
    } catch {
      // 데몬 상태 확인 실패 → 무시하고 진행
    }
  }

  const targets = [SESSIONS_FILE, WORKSPACES_FILE].filter((f) => existsSync(f));

  if (targets.length === 0) {
    console.log(`\n  ${t("cli.clear.noData")}\n`);
    return;
  }

  console.log(`\n  ${t("cli.clear.header")}`);
  for (const f of targets) {
    console.log(`  • ${f}`);
  }
  console.log("");

  const ok = await confirm({ message: t("cli.clear.confirm"), default: false });

  if (!ok) {
    console.log(`\n  ${t("cli.clear.cancelled")}\n`);
    return;
  }

  for (const f of targets) {
    unlinkSync(f);
  }
  console.log(`\n  ${t("cli.clear.done")}\n`);
}

// ── start command ─────────────────────────────────────────────

async function start(daemon: boolean): Promise<void> {
  ensureDirs();
  await ensureConfig(daemon);

  if (daemon) {
    await startDaemon();
    return;
  }

  // 포그라운드 실행 시 로그를 파일에도 기록
  // (daemon 모드에서는 launchd가 stderr를 파일로 리다이렉트하므로 중복 방지)
  if (process.stderr.isTTY) {
    const { enableFileLogging } = await import("./core/logger.js");
    enableFileLogging(LOG_ERR);
  }

  await import("./server.js");
}

const command = process.argv[2];
const flags = process.argv.slice(3);
const isDaemon = flags.includes("--daemon") || flags.includes("-d");

(async () => {
  switch (command) {
    case "start":
      await start(isDaemon);
      break;
    case undefined:
      printHelp();
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status":
      await showStatus();
      break;
    case "show":
      showSessions();
      break;
    case "clear":
      await clearData();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(t("cli.unknownCommand", { command }));
      printHelp();
      process.exit(1);
  }
})().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
