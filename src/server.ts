import bolt from "@slack/bolt";
const { App, LogLevel } = bolt;

import { writeFileSync, unlinkSync } from "fs";
import { config } from "./core/config.js";
import { initLocale } from "./i18n/index.js";
import { createLogger, createBoltLogger } from "./core/logger.js";
import { registerClaudeCommand, registerQuestionHandlers, registerInitHandlers } from "./handlers/index.js";
import { sessionManager } from "./claude/session-manager.js";
import { killAllRunners } from "./claude/active-runners.js";
import { PID_FILE } from "./core/paths.js";

// locale은 앞으로 env 기반 선택이 추가될 수 있어, config 접근 전에 미리 초기화한다.
// (현재는 en만 지원하므로 initLocale은 no-op)
initLocale();

const log = createLogger("server");

// 글로벌 에러 핸들러 (마지막 방어선)
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", error);
  killAllRunners();
  try {
    unlinkSync(PID_FILE);
  } catch {
    // 파일이 없을 수 있음
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", reason instanceof Error ? reason : { reason });
});

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
  logLevel: LogLevel.INFO,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: createBoltLogger() as any,
});

// 핸들러 등록
registerClaudeCommand(app);
registerQuestionHandlers(app);
registerInitHandlers(app);

// Graceful shutdown: 자식 프로세스 정리 후 종료
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info("Shutdown signal received, cleaning up", { signal });

  const killed = killAllRunners();
  log.info("Active runners terminated", { count: killed });

  try {
    await app.stop();
    log.info("Slack app stopped");
  } catch (error) {
    log.error("Error stopping Slack app", error);
  }

  // PID 파일 정리
  try {
    unlinkSync(PID_FILE);
  } catch {
    // 파일이 없을 수 있음
  }

  // in-flight 비동기 작업(Slack 메시지 전송 등)이 완료될 시간 확보
  await new Promise((resolve) => setTimeout(resolve, 2000));

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// 서버 시작
(async () => {
  await app.start();

  // PID 파일 작성 (daemon stop 시 프로세스 트리 종료에 사용)
  // 서버 시작 성공 후 작성해야 실패 시 stale PID 파일이 남지 않음
  writeFileSync(PID_FILE, String(process.pid));

  log.info("Server started (Socket Mode)", {
    activeSessions: sessionManager.getActiveCount(),
  });
})().catch((error) => {
  log.error("Failed to start server", error);
  process.exit(1);
});
