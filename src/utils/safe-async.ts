import { createLogger } from "../core/logger.js";

const log = createLogger("safe-async");

/**
 * async EventEmitter 콜백을 try-catch로 감싸는 래퍼.
 * EventEmitter는 async 콜백의 rejection을 자동 처리하지 않으므로,
 * 이 래퍼를 사용하여 unhandledRejection을 방지한다.
 */
export function safeAsync<T extends unknown[]>(
  handler: (...args: T) => Promise<void>,
  context: string,
): (...args: T) => void {
  return (...args: T) => {
    handler(...args).catch((error) => {
      log.error(`Error in async handler [${context}]`, error);
    });
  };
}
