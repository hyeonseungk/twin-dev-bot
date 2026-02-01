/**
 * 활성 러너 레지스트리
 *
 * Slack 스레드(threadTs)별로 실행 중인 ClaudeRunner 인스턴스를 추적하여
 * 동일 스레드에서 여러 Claude 프로세스가 동시에 실행되는 것을 방지합니다.
 *
 * - 마지막 이벤트 수신 후 config.inactivityTimeoutMs(기본 30분) 동안
 *   활동이 없으면 프로세스를 자동 종료하고 스레드 잠금을 해제합니다.
 * - onTimeout 콜백을 통해 Slack 타임아웃 알림 등 외부 처리가 가능합니다.
 */

import type { ClaudeRunner } from "./claude-runner.js";
import { createLogger } from "../core/logger.js";
import { config } from "../core/config.js";

const log = createLogger("active-runners");

interface RunnerEntry {
  runner: ClaudeRunner;
  timer: ReturnType<typeof setTimeout>;
  registeredAt: number;
  lastActivityAt: number;
  onTimeout?: () => void;
}

const activeRunners = new Map<string, RunnerEntry>();

function startTimer(threadTs: string, entry: RunnerEntry): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    log.warn("Runner inactivity timeout", {
      threadTs,
      inactiveMs: Date.now() - entry.lastActivityAt,
      totalMs: Date.now() - entry.registeredAt,
    });

    // 콜백 실행 (Slack 알림 등)
    try {
      entry.onTimeout?.();
    } catch (err) {
      log.error("onTimeout callback error", err);
    }

    // 프로세스 종료 및 등록 해제
    entry.runner.kill();
    activeRunners.delete(threadTs);
  }, config.inactivityTimeoutMs);
}

export interface RegisterRunnerOptions {
  /** 타임아웃 시 호출할 콜백 (Slack 알림 등) */
  onTimeout?: () => void;
}

/**
 * 러너를 활성 상태로 등록
 */
export function registerRunner(
  threadTs: string,
  runner: ClaudeRunner,
  options?: RegisterRunnerOptions,
): void {
  // 기존 엔트리가 있으면 프로세스 종료 및 타이머 정리
  const existing = activeRunners.get(threadTs);
  if (existing) {
    clearTimeout(existing.timer);
    existing.runner.kill();
    log.info("Previous runner killed on re-register", { threadTs });
  }

  const now = Date.now();
  const entry: RunnerEntry = {
    runner,
    timer: null as unknown as ReturnType<typeof setTimeout>,
    registeredAt: now,
    lastActivityAt: now,
    onTimeout: options?.onTimeout,
  };
  entry.timer = startTimer(threadTs, entry);

  activeRunners.set(threadTs, entry);
  log.debug("Runner registered", { threadTs });
}

/**
 * 이벤트 수신 시 활동 시간 갱신 및 타임아웃 리셋
 * 저장된 runner와 동일한 인스턴스인 경우에만 갱신 (stale 갱신 방지)
 */
export function refreshActivity(threadTs: string, runner: ClaudeRunner): void {
  const entry = activeRunners.get(threadTs);
  if (!entry || entry.runner !== runner) return;

  entry.lastActivityAt = Date.now();
  clearTimeout(entry.timer);
  entry.timer = startTimer(threadTs, entry);
}

/**
 * 러너를 비활성 상태로 해제
 * 저장된 runner와 동일한 인스턴스인 경우에만 해제 (stale 해제 방지)
 */
export function unregisterRunner(threadTs: string, runner: ClaudeRunner): void {
  const entry = activeRunners.get(threadTs);
  if (!entry || entry.runner !== runner) return;

  clearTimeout(entry.timer);
  activeRunners.delete(threadTs);
  log.debug("Runner unregistered", { threadTs });
}

/**
 * 해당 스레드에 활성 러너가 있는지 확인
 */
export function isRunnerActive(threadTs: string): boolean {
  return activeRunners.has(threadTs);
}

/**
 * 활성 러너를 강제 종료하고 등록 해제.
 * autopilot 개입, /twindevbot stop 명령, 일반 모드 인터럽트 등
 * 외부 요청에 의해 실행 중인 작업을 중단할 때 사용합니다.
 */
export function killActiveRunner(threadTs: string): void {
  const entry = activeRunners.get(threadTs);
  if (!entry) return;

  clearTimeout(entry.timer);
  entry.runner.kill();
  activeRunners.delete(threadTs);
  log.info("Runner killed by external request", { threadTs });
}

/**
 * 모든 활성 러너를 강제 종료하고 등록 해제
 * (graceful shutdown 시 고아 프로세스 방지)
 */
export function killAllRunners(): number {
  const count = activeRunners.size;
  for (const [threadTs, entry] of activeRunners) {
    clearTimeout(entry.timer);
    entry.runner.kill();
    log.info("Runner killed during shutdown", { threadTs });
  }
  activeRunners.clear();
  return count;
}
