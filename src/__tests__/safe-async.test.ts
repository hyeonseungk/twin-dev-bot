const mockLogError = vi.hoisted(() => vi.fn());

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
  }),
}));

import { safeAsync } from "../utils/safe-async.js";

describe("safeAsync", () => {
  it("returns a function", () => {
    const handler = async () => {};
    const wrapped = safeAsync(handler, "test");
    expect(typeof wrapped).toBe("function");
  });

  it("calls handler with all arguments", async () => {
    const handler = vi.fn(async (_a: string, _b: number) => {});
    const wrapped = safeAsync(handler, "test");

    wrapped("hello", 42);

    // Let the microtask queue flush so the async handler completes
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith("hello", 42);
    });
  });

  it("does not throw when handler resolves", () => {
    const handler = async () => {};
    const wrapped = safeAsync(handler, "test");

    expect(() => wrapped()).not.toThrow();
  });

  it("catches rejection and logs error", async () => {
    const error = new Error("async failure");
    const handler = async () => {
      throw error;
    };
    const wrapped = safeAsync(handler, "test");

    wrapped();

    // Wait for the rejection to be caught and logged
    await vi.waitFor(() => {
      expect(mockLogError).toHaveBeenCalledWith(
        "Error in async handler [test]",
        error,
      );
    });
  });

  it("handles synchronous throw inside async handler", async () => {
    const error = new Error("sync throw in async");
    const handler = async () => {
      throw error;
    };
    const wrapped = safeAsync(handler, "sync-ctx");

    // The wrapper itself should not throw
    expect(() => wrapped()).not.toThrow();

    await vi.waitFor(() => {
      expect(mockLogError).toHaveBeenCalledWith(
        "Error in async handler [sync-ctx]",
        error,
      );
    });
  });
});
