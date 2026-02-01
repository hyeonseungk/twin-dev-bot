import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { withRetry } from "../utils/slack-rate-limit.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on rate_limited error and succeeds", async () => {
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      data: { error: "rate_limited" },
      retryAfter: 1,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    // Advance past the 1-second sleep
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects retryAfter from error object", async () => {
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      data: { error: "rate_limited" },
      retryAfter: 5,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);

    // 4 seconds: not enough
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(1);

    // 1 more second: should retry
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects retry-after from headers", async () => {
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      data: { error: "rate_limited" },
      headers: { "retry-after": "3" },
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("defaults to 1 second when no retryAfter info", async () => {
    const rateLimitError = Object.assign(new Error("rate_limited"), {
      data: { error: "rate_limited" },
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exhausted", async () => {
    const makeError = () =>
      Object.assign(new Error("rate_limited"), {
        data: { error: "rate_limited" },
        retryAfter: 1,
      });
    const fn = vi.fn()
      .mockRejectedValueOnce(makeError())
      .mockRejectedValueOnce(makeError())
      .mockRejectedValueOnce(makeError());

    const promise = withRetry(fn, 2).catch((e) => e);

    // Advance through all retries: attempt 0 fails, sleep 1s, attempt 1 fails, sleep 1s, attempt 2 fails
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const error = await promise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("rate_limited");
    expect(fn).toHaveBeenCalledTimes(3); // 0, 1, 2
  });

  it("throws non-rate-limited errors immediately without retry", async () => {
    const otherError = Object.assign(new Error("channel_not_found"), {
      data: { error: "channel_not_found" },
    });
    const fn = vi.fn().mockRejectedValue(otherError);

    await expect(withRetry(fn)).rejects.toThrow("channel_not_found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws errors without data property immediately", async () => {
    const networkError = new Error("ECONNREFUSED");
    const fn = vi.fn().mockRejectedValue(networkError);

    await expect(withRetry(fn)).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
