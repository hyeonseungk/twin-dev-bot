import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";
import { input } from "@inquirer/prompts";
import { ENV_FILE } from "./core/paths.js";
import { initLocale, t } from "./i18n/index.js";
import { getDefaultBaseDir, expandTilde } from "./core/platform.js";
import { getDisplayWidth } from "./utils/display-width.js";

interface EnvValues {
  SLACK_APP_TOKEN: string;
  SLACK_BOT_TOKEN: string;
  TWINDEVBOT_BASE_DIR: string;
  LOG_LEVEL: string;
}

function loadCurrentEnv(): Partial<EnvValues> {
  if (!existsSync(ENV_FILE)) return {};

  const parsed = dotenv.parse(readFileSync(ENV_FILE, "utf-8"));
  return {
    SLACK_APP_TOKEN: parsed.SLACK_APP_TOKEN || undefined,
    SLACK_BOT_TOKEN: parsed.SLACK_BOT_TOKEN || undefined,
    TWINDEVBOT_BASE_DIR: parsed.TWINDEVBOT_BASE_DIR || undefined,
    LOG_LEVEL: parsed.LOG_LEVEL || undefined,
  };
}

function writeEnvFile(values: EnvValues): void {
  const lines = [
    `SLACK_BOT_TOKEN="${values.SLACK_BOT_TOKEN}"`,
    `SLACK_APP_TOKEN="${values.SLACK_APP_TOKEN}"`,
    `TWINDEVBOT_BASE_DIR="${values.TWINDEVBOT_BASE_DIR}"`,
    `LOG_LEVEL="${values.LOG_LEVEL}"`,
  ];
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");

  // Unix에서 .env 파일 권한을 소유자만 읽기/쓰기로 설정 (토큰 보호)
  if (process.platform !== "win32") {
    try { chmodSync(ENV_FILE, 0o600); } catch { /* ignore */ }
  }
}

const DEFAULT_BASE_DIR = getDefaultBaseDir();

function printBanner(): void {
  const title = t("cli.setup.banner");
  const titleWidth = getDisplayWidth(title);
  const innerWidth = 34;
  const padLeft = Math.floor((innerWidth - titleWidth) / 2);
  const padRight = innerWidth - titleWidth - padLeft;
  console.log("");
  console.log(`  ┌${"─".repeat(innerWidth)}┐`);
  console.log(`  │${" ".repeat(padLeft)}${title}${" ".repeat(padRight)}│`);
  console.log(`  └${"─".repeat(innerWidth)}┘`);
  console.log("");
}

function printStartMessage(daemon: boolean): void {
  console.log("");
  if (daemon) {
    console.log(`  ✅ ${t("cli.setup.startDaemonMessage")}`);
  } else {
    console.log(`  ✅ ${t("cli.setup.startMessage")}`);
  }
  console.log("");
}

function applyToProcessEnv(values: EnvValues): void {
  process.env.SLACK_APP_TOKEN = values.SLACK_APP_TOKEN;
  process.env.SLACK_BOT_TOKEN = values.SLACK_BOT_TOKEN;
  process.env.TWINDEVBOT_BASE_DIR = values.TWINDEVBOT_BASE_DIR;
  process.env.LOG_LEVEL = values.LOG_LEVEL;
}

/**
 * .env 파일을 확인하고 비어있는 값이 있으면 인터랙티브 프롬프트로 입력받는다.
 * 모든 값이 채워져 있으면 프롬프트 없이 통과한다.
 */
export async function ensureConfig(daemon: boolean): Promise<void> {
  const current = loadCurrentEnv();

  const needAppToken = !current.SLACK_APP_TOKEN;
  const needBotToken = !current.SLACK_BOT_TOKEN;
  const needBaseDir = !current.TWINDEVBOT_BASE_DIR;
  const needsSetup = needAppToken || needBotToken || needBaseDir;

  if (!needsSetup) {
    const values: EnvValues = {
      SLACK_APP_TOKEN: current.SLACK_APP_TOKEN!,
      SLACK_BOT_TOKEN: current.SLACK_BOT_TOKEN!,
      TWINDEVBOT_BASE_DIR: current.TWINDEVBOT_BASE_DIR!,
      LOG_LEVEL: current.LOG_LEVEL ?? "info",
    };
    if (!current.LOG_LEVEL) {
      writeEnvFile(values);
    }
    applyToProcessEnv(values);
    return;
  }

  // 비대화형 환경(launchd 데몬 등)에서는 프롬프트를 실행할 수 없으므로 즉시 종료
  if (!process.stdin.isTTY) {
    const missing = [
      needAppToken && "SLACK_APP_TOKEN",
      needBotToken && "SLACK_BOT_TOKEN",
      needBaseDir && "TWINDEVBOT_BASE_DIR",
    ].filter(Boolean);
    console.error(
      `[twindevbot] Missing required config: ${missing.join(", ")}. ` +
        `Run "twindevbot start" interactively to set up, or edit ${ENV_FILE} manually.`
    );
    process.exit(1);
  }

  printBanner();

  const maskToken = (v: string, { isFinal }: { isFinal: boolean }) =>
    isFinal && v.length > 10 ? v.slice(0, 10) + "..." : v;

  const appToken = needAppToken
    ? (
        await input({
          message: t("cli.setup.promptAppToken") + "\n ",
          transformer: maskToken,
          validate: (v) => (v.trim() ? true : t("cli.setup.required")),
        })
      ).trim()
    : current.SLACK_APP_TOKEN!;

  const botToken = needBotToken
    ? (
        await input({
          message: t("cli.setup.promptBotToken") + "\n ",
          transformer: maskToken,
          validate: (v) => (v.trim() ? true : t("cli.setup.required")),
        })
      ).trim()
    : current.SLACK_BOT_TOKEN!;

  const baseDir = needBaseDir
    ? expandTilde(
        (
          await input({
            message: t("cli.setup.promptBaseDir") + "\n ",
            default: DEFAULT_BASE_DIR,
          })
        ).trim()
      )
    : current.TWINDEVBOT_BASE_DIR!;

  const values: EnvValues = {
    SLACK_APP_TOKEN: appToken,
    SLACK_BOT_TOKEN: botToken,
    TWINDEVBOT_BASE_DIR: baseDir,
    LOG_LEVEL: current.LOG_LEVEL ?? "info",
  };

  writeEnvFile(values);
  applyToProcessEnv(values);
  initLocale();

  console.log("");
  console.log(`  ✔ ${t("cli.setup.saved", { path: ENV_FILE })}`);
  printStartMessage(daemon);
}
