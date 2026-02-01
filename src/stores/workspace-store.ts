/**
 * Workspace Store
 *
 * /twindevbot goto 로 생성된 스레드와 작업 디렉토리의 매핑을 관리합니다.
 * 스레드에 첫 메시지가 오면 이 매핑을 사용하여 Claude 세션을 시작합니다.
 *
 * 키: threadTs (Slack 스레드 부모 메시지 타임스탬프)
 * 값: { directory, projectName, channelId }
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { createLogger } from "../core/logger.js";
import { WORKSPACES_FILE } from "../core/paths.js";

const log = createLogger("workspace-store");

export interface Workspace {
  directory: string;
  projectName: string;
  channelId: string;
  autopilot?: boolean;
  createdAt?: Date;
}

interface SerializedWorkspace {
  threadTs: string;
  directory: string;
  projectName: string;
  channelId: string;
  autopilot?: boolean;
  createdAt?: string;
}

interface WorkspacesFile {
  version: number;
  workspaces: SerializedWorkspace[];
}

const workspaces = new Map<string, Workspace>();
let cleanupInterval: NodeJS.Timeout | null = null;

// 24시간이 지난 워크스페이스는 자동 삭제
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadFromFile(): void {
  try {
    if (!existsSync(WORKSPACES_FILE)) {
      log.info("No workspaces file found, starting fresh");
      return;
    }

    const content = readFileSync(WORKSPACES_FILE, "utf-8");

    let data: WorkspacesFile;
    try {
      data = JSON.parse(content);
    } catch (parseError) {
      log.error("Workspaces file is corrupted, starting fresh", { parseError });
      return;
    }

    if (!data.workspaces || !Array.isArray(data.workspaces)) {
      log.error("Workspaces file has invalid structure, starting fresh");
      return;
    }

    let loadedCount = 0;
    for (const w of data.workspaces) {
      try {
        workspaces.set(w.threadTs, {
          directory: w.directory,
          projectName: w.projectName,
          channelId: w.channelId,
          autopilot: w.autopilot,
          createdAt: w.createdAt ? new Date(w.createdAt) : new Date(),
        });
        loadedCount++;
      } catch (entryError) {
        log.warn("Skipping invalid workspace entry", { entry: w, error: entryError });
      }
    }

    log.info("Workspaces loaded from file", { count: loadedCount, total: data.workspaces.length });
  } catch (error) {
    log.error("Failed to load workspaces from file", { error });
  }
}

function saveToFile(): void {
  try {
    const serialized: SerializedWorkspace[] = Array.from(workspaces.entries()).map(
      ([threadTs, w]) => ({
        threadTs,
        directory: w.directory,
        projectName: w.projectName,
        channelId: w.channelId,
        autopilot: w.autopilot ?? undefined,
        createdAt: w.createdAt?.toISOString(),
      })
    );

    const data: WorkspacesFile = {
      version: 1,
      workspaces: serialized,
    };

    const tmpFile = WORKSPACES_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    renameSync(tmpFile, WORKSPACES_FILE);
    log.debug("Workspaces saved to file", { count: serialized.length });
  } catch (error) {
    log.error("Failed to save workspaces to file", { error });
  }
}

// 모듈 로드 시 파일에서 복원
loadFromFile();

// 정리 타이머 시작
function startCleanupTimer(): void {
  if (cleanupInterval) return;

  // 매 시간마다 실행 (첫 실행은 1시간 후)
  cleanupInterval = setInterval(() => {
    cleanup();
  }, 60 * 60 * 1000);
  cleanupInterval.unref();

  log.debug("Workspace cleanup timer started (runs every hour)");
}

startCleanupTimer();

export function addWorkspace(threadTs: string, workspace: Workspace): void {
  // createdAt이 없으면 현재 시간으로 설정
  if (!workspace.createdAt) {
    workspace.createdAt = new Date();
  }

  workspaces.set(threadTs, workspace);
  log.info("Workspace registered", {
    threadTs,
    projectName: workspace.projectName,
    directory: workspace.directory,
  });
  saveToFile();
}

export function getWorkspace(threadTs: string): Workspace | undefined {
  return workspaces.get(threadTs);
}

export function removeWorkspace(threadTs: string): void {
  workspaces.delete(threadTs);
  log.debug("Workspace removed", { threadTs });
  saveToFile();
}

/**
 * 오래된 워크스페이스 정리 (createdAt 기준)
 */
function cleanup(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [threadTs, workspace] of workspaces.entries()) {
    // createdAt이 없는 항목은 건너뜀 (레거시 데이터)
    if (!workspace.createdAt) {
      continue;
    }

    const ageMs = now - workspace.createdAt.getTime();
    if (ageMs > MAX_AGE_MS) {
      workspaces.delete(threadTs);
      cleanedCount++;
      log.info("Workspace expired", {
        threadTs,
        projectName: workspace.projectName,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      });
    }
  }

  if (cleanedCount > 0) {
    saveToFile();
    log.info("Workspace cleanup completed", { cleanedCount, remaining: workspaces.size });
  }

  return cleanedCount;
}

/**
 * 정리 타이머 중지 (주로 테스트용)
 */
export function stopCleanupTimer(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.debug("Workspace cleanup timer stopped");
  }
}

/**
 * 테스트용: cleanup 수동 실행
 */
export function runCleanup(): number {
  return cleanup();
}
