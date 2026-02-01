import { createLogger } from "../core/logger.js";

const log = createLogger("slack-rate-limit");

const DEFAULT_MAX_RETRIES = 3;

/**
 * Slack API 호출을 429 (rate_limited) 에러에 대해 자동 재시도하는 래퍼.
 * Slack의 Retry-After 값을 존중하며, 최대 maxRetries 회까지 재시도.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const isRateLimited = isRateLimitedError(error);

      if (!isRateLimited || attempt === maxRetries) {
        throw error;
      }

      const retryAfterSec = parseRetryAfter(error) ?? 1;
      const waitMs = retryAfterSec * 1000;

      log.warn("Rate limited by Slack, retrying", {
        attempt: attempt + 1,
        maxRetries,
        waitMs,
      });

      await sleep(waitMs);
    }
  }

  // TypeScript needs this, but it's unreachable
  throw new Error("withRetry: exhausted retries");
}

function isRateLimitedError(error: unknown): boolean {
  const err = error as { data?: { error?: string } };
  return err?.data?.error === "rate_limited";
}

function parseRetryAfter(error: unknown): number | null {
  const err = error as {
    retryAfter?: number;
    headers?: Record<string, string>;
  };

  if (typeof err?.retryAfter === "number") return err.retryAfter;

  const header = err?.headers?.["retry-after"] ?? err?.headers?.["Retry-After"];
  if (header) {
    const parsed = parseInt(header, 10);
    if (!isNaN(parsed)) return parsed;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
