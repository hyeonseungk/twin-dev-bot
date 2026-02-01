/**
 * 복수 질문 배치 관리
 *
 * Claude의 AskUserQuestion이 여러 질문을 동시에 보낼 때,
 * Slack에서는 한 번에 하나씩 표시하고 모든 답변을 수집한 후
 * 조합하여 Claude에 전달합니다.
 *
 * 키: threadTs (스레드당 하나의 배치)
 */

import { createLogger } from "../core/logger.js";
import type { Question } from "../types/conversation.js";

const log = createLogger("pending-questions");

export interface PendingQuestionBatch {
  questions: Question[];
  answers: string[];
  currentIndex: number;
  projectName: string;
  channelId: string;
  createdAt: number;
}

const batchMap = new Map<string, PendingQuestionBatch>();

// 1시간이 지난 배치는 자동 삭제 (정상적으로는 오래 걸리지 않음)
const MAX_AGE_MS = 60 * 60 * 1000;
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * 배치 초기화 (questions.length > 1일 때 호출)
 */
export function initPendingBatch(
  threadTs: string,
  questions: Question[],
  projectName: string,
  channelId: string,
): void {
  batchMap.set(threadTs, {
    questions,
    answers: [],
    currentIndex: 0,
    projectName,
    channelId,
    createdAt: Date.now(),
  });
  log.info("Pending batch initialized", { threadTs, questionCount: questions.length });

  // 타이머가 없으면 시작
  ensureCleanupTimer();
}

/**
 * 대기 중인 배치 존재 여부
 */
export function hasPendingBatch(threadTs: string): boolean {
  return batchMap.has(threadTs);
}

/**
 * 답변 기록 후 다음 질문 반환.
 * done=true이면 모든 질문에 답변 완료.
 */
export function recordAnswerAndAdvance(
  threadTs: string,
  answer: string,
): { done: boolean; nextQuestion?: Question; batch: PendingQuestionBatch } | null {
  const batch = batchMap.get(threadTs);
  if (!batch) return null;

  batch.answers.push(answer);
  batch.currentIndex++;

  if (batch.currentIndex >= batch.questions.length) {
    return { done: true, batch };
  }

  return {
    done: false,
    nextQuestion: batch.questions[batch.currentIndex],
    batch,
  };
}

/**
 * 모든 답변을 조합하여 Claude resume용 문자열 생성.
 * 형식: "[header]: answer" (줄바꿈 구분)
 * header가 없으면 질문 텍스트 앞 50자 사용.
 */
export function buildCombinedAnswer(threadTs: string): string | null {
  const batch = batchMap.get(threadTs);
  if (!batch) return null;

  if (batch.questions.length === 1) {
    return batch.answers[0] ?? null;
  }

  return batch.questions
    .map((q, i) => {
      const label = q.header || q.question.slice(0, 50);
      const answer = batch.answers[i] ?? "";
      return `[${label}]: ${answer}`;
    })
    .join("\n");
}

/**
 * 배치 정리
 */
export function clearPendingBatch(threadTs: string): void {
  batchMap.delete(threadTs);
  log.debug("Pending batch cleared", { threadTs });
}

/**
 * 오래된 배치 정리
 */
function cleanup(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [threadTs, batch] of batchMap.entries()) {
    const ageMs = now - batch.createdAt;
    if (ageMs > MAX_AGE_MS) {
      batchMap.delete(threadTs);
      cleanedCount++;
      log.info("Pending batch expired", {
        threadTs,
        projectName: batch.projectName,
        ageMinutes: Math.floor(ageMs / (60 * 1000)),
        answeredCount: batch.answers.length,
        totalCount: batch.questions.length,
      });
    }
  }

  if (cleanedCount > 0) {
    log.info("Pending batch cleanup completed", { cleanedCount, remaining: batchMap.size });
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

  log.debug("Pending batch cleanup timer started (runs every hour)");
}

/**
 * 정리 타이머 중지 (주로 테스트용)
 */
export function stopCleanupTimer(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.debug("Pending batch cleanup timer stopped");
  }
}

/**
 * 테스트용: cleanup 수동 실행
 */
export function runCleanup(): number {
  return cleanup();
}
