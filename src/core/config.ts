import dotenv from "dotenv";
import { ENV_FILE } from "./paths.js";
import { createLogger } from "./logger.js";
import { expandTilde, getDefaultBaseDir } from "./platform.js";

const log = createLogger("config");

let _initialized = false;

function ensureInit(): void {
  if (_initialized) return;
  _initialized = true;

  dotenv.config({ path: ENV_FILE, override: true });

  const missing: string[] = [];
  if (!process.env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!process.env.SLACK_APP_TOKEN) missing.push("SLACK_APP_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
      `Please configure them in your .env file.`
    );
  }
}

export const config = {
  get slack() {
    ensureInit();
    return {
      botToken: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
    };
  },
  get baseDir() {
    ensureInit();
    const raw = process.env.TWINDEVBOT_BASE_DIR;
    return raw ? expandTilde(raw) : getDefaultBaseDir();
  },
  get inactivityTimeoutMinutes() {
    ensureInit();
    const DEFAULT_MINUTES = 30;
    const raw = process.env.INACTIVITY_TIMEOUT_MINUTES;
    const parsed = parseInt(raw || String(DEFAULT_MINUTES), 10);
    if (isNaN(parsed) || parsed < 1) {
      log.warn(
        `Invalid INACTIVITY_TIMEOUT_MINUTES="${raw}", using default ${DEFAULT_MINUTES} minutes`,
      );
      return DEFAULT_MINUTES;
    }
    return parsed;
  },
  get inactivityTimeoutMs() {
    return this.inactivityTimeoutMinutes * 60 * 1000;
  },
};
