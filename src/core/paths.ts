import { mkdirSync } from "fs";
import { join } from "path";

// 프로젝트 루트: 프로세스 실행 디렉토리 기준
const PROJECT_ROOT = process.cwd();

export const ENV_FILE = join(PROJECT_ROOT, ".env");
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
export const WORKSPACES_FILE = join(DATA_DIR, "workspaces.json");
export const CHANNELS_FILE = join(DATA_DIR, "channels.json");
export const LOG_DIR = join(PROJECT_ROOT, "logs");
export const LOG_OUT = join(LOG_DIR, "twindevbot.out.log");
export const LOG_ERR = join(LOG_DIR, "twindevbot.err.log");
export const PID_FILE = join(DATA_DIR, "twindevbot.pid");

/** DATA_DIR, LOG_DIR 가 없으면 생성. 서버/데몬 기동 시에만 호출할 것 */
export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}
