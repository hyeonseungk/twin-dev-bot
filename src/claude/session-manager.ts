import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { createLogger } from "../core/logger.js";
import { SESSIONS_FILE } from "../core/paths.js";

const log = createLogger("session-manager");

export interface ClaudeSession {
  sessionId: string;
  projectName: string;
  directory: string;
  slackChannelId: string;
  slackThreadTs: string; // 스레드 부모 메시지의 ts
  startedAt: Date;
  lastActivityAt: Date;
  autopilot: boolean;
}

// 파일 저장용 직렬화 형식
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

interface SessionsFile {
  version: number;
  sessions: SerializedSession[];
}

/**
 * 세션 키 생성: projectName:threadTs
 */
function makeSessionKey(projectName: string, threadTs: string): string {
  return `${projectName}:${threadTs}`;
}

class SessionManager {
  private sessions = new Map<string, ClaudeSession>();
  // sessionKey (projectName:threadTs) -> sessionId 매핑
  private sessionKeyToId = new Map<string, string>();
  // threadTs -> sessionId 매핑 (스레드로 세션 찾기)
  private threadToSession = new Map<string, string>();
  private loaded = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  // 24시간 동안 활동이 없는 세션은 자동 삭제
  private static readonly MAX_INACTIVE_MS = 24 * 60 * 60 * 1000;

  /**
   * 파일 로드를 지연 실행. 첫 접근 시 한 번만 호출됨.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadFromFile();
    this.startCleanupTimer();
  }

  /**
   * 파일에서 세션 로드
   */
  private loadFromFile(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) {
        log.info("No sessions file found, starting fresh");
        return;
      }

      const content = readFileSync(SESSIONS_FILE, "utf-8");

      let data: SessionsFile;
      try {
        data = JSON.parse(content);
      } catch (parseError) {
        log.error("Sessions file is corrupted, starting fresh", { parseError });
        return;
      }

      if (!data.sessions || !Array.isArray(data.sessions)) {
        log.error("Sessions file has invalid structure, starting fresh");
        return;
      }

      let loadedCount = 0;
      for (const s of data.sessions) {
        try {
          const session: ClaudeSession = {
            sessionId: s.sessionId,
            projectName: s.projectName,
            directory: s.directory,
            slackChannelId: s.slackChannelId,
            slackThreadTs: s.slackThreadTs,
            startedAt: new Date(s.startedAt),
            lastActivityAt: new Date(s.lastActivityAt),
            autopilot: s.autopilot ?? false,
          };

          this.sessions.set(session.sessionId, session);
          const key = makeSessionKey(session.projectName, session.slackThreadTs);
          this.sessionKeyToId.set(key, session.sessionId);
          this.threadToSession.set(session.slackThreadTs, session.sessionId);
          loadedCount++;
        } catch (sessionError) {
          log.warn("Skipping invalid session entry", { entry: s, error: sessionError });
        }
      }

      log.info("Sessions loaded from file", { count: loadedCount, total: data.sessions.length });
    } catch (error) {
      log.error("Failed to load sessions from file", { error });
    }
  }

  /**
   * 파일에 세션 저장
   */
  private saveToFile(): boolean {
    try {
      const sessions: SerializedSession[] = Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        projectName: s.projectName,
        directory: s.directory,
        slackChannelId: s.slackChannelId,
        slackThreadTs: s.slackThreadTs,
        startedAt: s.startedAt.toISOString(),
        lastActivityAt: s.lastActivityAt.toISOString(),
        autopilot: s.autopilot ?? undefined,
      }));

      const data: SessionsFile = {
        version: 1,
        sessions,
      };

      const tmpFile = SESSIONS_FILE + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      renameSync(tmpFile, SESSIONS_FILE);
      log.debug("Sessions saved to file", { count: sessions.length });
      return true;
    } catch (error) {
      log.error("Failed to save sessions to file", { error });
      return false;
    }
  }

  add(session: ClaudeSession): void {
    this.ensureLoaded();
    this.sessions.set(session.sessionId, session);
    const key = makeSessionKey(session.projectName, session.slackThreadTs);
    this.sessionKeyToId.set(key, session.sessionId);
    this.threadToSession.set(session.slackThreadTs, session.sessionId);

    log.info("Session added", {
      sessionId: session.sessionId,
      projectName: session.projectName,
      threadTs: session.slackThreadTs,
      sessionKey: key,
    });

    this.saveToFile();
  }

  get(sessionId: string): ClaudeSession | undefined {
    this.ensureLoaded();
    return this.sessions.get(sessionId);
  }

  /**
   * projectName과 threadTs로 세션 조회
   */
  getBySessionKey(projectName: string, threadTs: string): ClaudeSession | undefined {
    this.ensureLoaded();
    const key = makeSessionKey(projectName, threadTs);
    const sessionId = this.sessionKeyToId.get(key);
    if (sessionId) {
      return this.sessions.get(sessionId);
    }
    return undefined;
  }

  getByThread(threadTs: string): ClaudeSession | undefined {
    this.ensureLoaded();
    const sessionId = this.threadToSession.get(threadTs);
    if (sessionId) {
      return this.sessions.get(sessionId);
    }
    return undefined;
  }

  updateActivity(sessionId: string): void {
    this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
      this.saveToFile();
    }
  }

  /**
   * threadTs로 세션의 autopilot 플래그 변경
   */
  setAutopilot(threadTs: string, value: boolean): void {
    this.ensureLoaded();
    const sessionId = this.threadToSession.get(threadTs);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.autopilot = value;
      this.saveToFile();
      log.info("Session autopilot updated", { sessionId, threadTs, autopilot: value });
    }
  }

  remove(sessionId: string): void {
    this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (session) {
      const key = makeSessionKey(session.projectName, session.slackThreadTs);
      this.sessionKeyToId.delete(key);
      this.threadToSession.delete(session.slackThreadTs);
      this.sessions.delete(sessionId);
      log.info("Session removed", { sessionId });
      this.saveToFile();
    }
  }

  getActiveCount(): number {
    this.ensureLoaded();
    return this.sessions.size;
  }

  /**
   * 비활성 세션 정리 (lastActivityAt 기준)
   */
  cleanup(): number {
    this.ensureLoaded();
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const inactiveMs = now - session.lastActivityAt.getTime();
      if (inactiveMs > SessionManager.MAX_INACTIVE_MS) {
        const key = makeSessionKey(session.projectName, session.slackThreadTs);
        this.sessionKeyToId.delete(key);
        this.threadToSession.delete(session.slackThreadTs);
        this.sessions.delete(sessionId);
        cleanedCount++;
        log.info("Session expired due to inactivity", {
          sessionId,
          projectName: session.projectName,
          inactiveDays: Math.floor(inactiveMs / (24 * 60 * 60 * 1000)),
        });
      }
    }

    if (cleanedCount > 0) {
      this.saveToFile();
      log.info("Session cleanup completed", { cleanedCount, remaining: this.sessions.size });
    }

    return cleanedCount;
  }

  /**
   * 주기적 정리 타이머 시작 (매 시간마다)
   */
  private startCleanupTimer(): void {
    if (this.cleanupInterval) return;

    // 매 시간마다 실행 (첫 실행은 1시간 후)
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000);
    this.cleanupInterval.unref();

    log.debug("Session cleanup timer started (runs every hour)");
  }

  /**
   * 정리 타이머 중지 (주로 테스트용)
   */
  stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      log.debug("Session cleanup timer stopped");
    }
  }

  /**
   * 테스트용: cleanup 수동 실행
   */
  runCleanup(): number {
    return this.cleanup();
  }
}

export const sessionManager = new SessionManager();
