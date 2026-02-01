/**
 * 복수 선택 상태 관리
 *
 * multiSelect가 true인 질문에서 사용자가 선택한 옵션들을
 * "선택 완료" 버튼을 누르기 전까지 임시 저장합니다.
 *
 * 키: `${projectName}:${messageId}`
 * 값: { selected: 선택된 옵션 인덱스 Set, options: 전체 옵션 배열 }
 */

import { createLogger } from "../core/logger.js";
import type { QuestionOption } from "../types/conversation.js";

const log = createLogger("multi-select-state");

interface MultiSelectState {
  selected: Set<number>;
  options: QuestionOption[];
  questionText: string;
  header?: string;
  createdAt: number;
}

/** 선택 상태 저장소 */
const stateMap = new Map<string, MultiSelectState>();

// 1시간이 지난 상태는 자동 삭제 (multi-select는 오래 걸리지 않음)
const MAX_AGE_MS = 60 * 60 * 1000;
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * 키 생성 헬퍼
 */
function makeKey(projectName: string, messageId: string): string {
  return `${projectName}:${messageId}`;
}

interface InitStateOptions {
  projectName: string;
  messageId: string;
  options: QuestionOption[];
  questionText: string;
  header?: string;
}

/**
 * 상태 초기화 (질문 생성 시 호출)
 */
export function initState(opts: InitStateOptions): void {
  const key = makeKey(opts.projectName, opts.messageId);

  if (stateMap.has(key)) {
    log.debug("State already exists, skipping init", { key });
    return;
  }

  stateMap.set(key, {
    selected: new Set(),
    options: opts.options,
    questionText: opts.questionText,
    header: opts.header,
    createdAt: Date.now(),
  });

  log.debug("State initialized", { key, optionCount: opts.options.length });

  // 타이머가 없으면 시작
  ensureCleanupTimer();
}

/**
 * 옵션 토글 (선택/해제)
 * @returns 토글 후 선택 여부
 */
export function toggleOption(
  projectName: string,
  messageId: string,
  optionIndex: number
): boolean {
  const key = makeKey(projectName, messageId);
  const state = stateMap.get(key);

  if (!state) {
    log.warn("State not found for toggle", { key });
    return false;
  }

  if (state.selected.has(optionIndex)) {
    state.selected.delete(optionIndex);
    log.debug("Option deselected", { projectName, messageId, optionIndex });
    return false;
  } else {
    state.selected.add(optionIndex);
    log.debug("Option selected", { projectName, messageId, optionIndex });
    return true;
  }
}

/**
 * 선택된 옵션 인덱스 배열 조회
 */
export function getSelectedOptions(
  projectName: string,
  messageId: string
): number[] {
  const key = makeKey(projectName, messageId);
  const state = stateMap.get(key);

  if (!state) {
    return [];
  }

  return Array.from(state.selected).sort((a, b) => a - b);
}

/**
 * 전체 상태 조회 (옵션 정보 포함)
 */
export function getState(
  projectName: string,
  messageId: string
): MultiSelectState | null {
  const key = makeKey(projectName, messageId);
  return stateMap.get(key) ?? null;
}

/**
 * 특정 옵션이 선택되었는지 확인
 */
export function isOptionSelected(
  projectName: string,
  messageId: string,
  optionIndex: number
): boolean {
  const key = makeKey(projectName, messageId);
  const state = stateMap.get(key);
  return state?.selected.has(optionIndex) ?? false;
}

/**
 * 상태 삭제 (완료 후 정리용)
 */
export function clearState(projectName: string, messageId: string): void {
  const key = makeKey(projectName, messageId);
  stateMap.delete(key);
  log.debug("State cleared", { projectName, messageId });
}

/**
 * 오래된 상태 정리
 */
function cleanup(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [key, state] of stateMap.entries()) {
    const ageMs = now - state.createdAt;
    if (ageMs > MAX_AGE_MS) {
      stateMap.delete(key);
      cleanedCount++;
      log.info("Multi-select state expired", {
        key,
        ageMinutes: Math.floor(ageMs / (60 * 1000)),
      });
    }
  }

  if (cleanedCount > 0) {
    log.info("Multi-select cleanup completed", { cleanedCount, remaining: stateMap.size });
  }

  return cleanedCount;
}

/**
 * 정리 타이머 시작
 */
function ensureCleanupTimer(): void {
  if (cleanupInterval) return;

  // 즉시 한 번 실행
  cleanup();

  // 매 시간마다 실행
  cleanupInterval = setInterval(() => {
    cleanup();
  }, 60 * 60 * 1000);
  cleanupInterval.unref();

  log.debug("Multi-select cleanup timer started (runs every hour)");
}

/**
 * 정리 타이머 중지 (주로 테스트용)
 */
export function stopCleanupTimer(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.debug("Multi-select cleanup timer stopped");
  }
}

/**
 * 테스트용: cleanup 수동 실행
 */
export function runCleanup(): number {
  return cleanup();
}
