import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.LOG_LEVEL;
  });

  describe("log level filtering", () => {
    it("info level: logs info, warn, error but not debug", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "info";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("test");

      consoleSpy.mockClear();

      log.debug("debug msg");
      expect(consoleSpy).not.toHaveBeenCalled();

      log.info("info msg");
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      log.warn("warn msg");
      expect(consoleSpy).toHaveBeenCalledTimes(2);

      log.error("error msg");
      expect(consoleSpy).toHaveBeenCalledTimes(3);
    });

    it("debug level: logs everything", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("test");

      consoleSpy.mockClear();

      log.debug("debug msg");
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      log.info("info msg");
      expect(consoleSpy).toHaveBeenCalledTimes(2);

      log.warn("warn msg");
      expect(consoleSpy).toHaveBeenCalledTimes(3);

      log.error("error msg");
      expect(consoleSpy).toHaveBeenCalledTimes(4);
    });

    it("warn level: only warn and error", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "warn";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("test");

      consoleSpy.mockClear();

      log.debug("debug msg");
      expect(consoleSpy).not.toHaveBeenCalled();

      log.info("info msg");
      expect(consoleSpy).not.toHaveBeenCalled();

      log.warn("warn msg");
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      log.error("error msg");
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it("error level: only error", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "error";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("test");

      consoleSpy.mockClear();

      log.debug("debug msg");
      log.info("info msg");
      log.warn("warn msg");
      expect(consoleSpy).not.toHaveBeenCalled();

      log.error("error msg");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it("invalid LOG_LEVEL falls back to info and logs warning", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "verbose";
      const { createLogger } = await import("../core/logger.js");

      // parseLogLevel should have printed a warning during module load
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid LOG_LEVEL "verbose"'),
      );

      const log = createLogger("test");
      consoleSpy.mockClear();

      // Should behave as "info" level
      log.debug("debug msg");
      expect(consoleSpy).not.toHaveBeenCalled();

      log.info("info msg");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("output format", () => {
    it("includes ISO timestamp", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("fmt");

      consoleSpy.mockClear();
      log.info("test message");

      const output = consoleSpy.mock.calls[0][0] as string;
      // ISO timestamp pattern: 2025-01-01T00:00:00.000Z
      expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });

    it("includes level name padded to 5 chars", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("fmt");

      consoleSpy.mockClear();
      log.info("test message");

      const output = consoleSpy.mock.calls[0][0] as string;
      // "INFO " is 5 chars (padded with space)
      expect(output).toContain("INFO ");
    });

    it("includes context in brackets", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("myContext");

      consoleSpy.mockClear();
      log.info("test message");

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("[myContext]");
    });

    it("appends JSON data when provided", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("fmt");

      consoleSpy.mockClear();
      log.info("test message", { key: "value" });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('{"key":"value"}');
    });

    it("omits data when undefined", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("fmt");

      consoleSpy.mockClear();
      log.info("test message");

      const output = consoleSpy.mock.calls[0][0] as string;
      // The message should end with "test message" and not have trailing JSON
      expect(output).toMatch(/test message$/);
    });
  });

  describe("error method", () => {
    it("serializes Error objects with message and stack", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "error";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("err");

      consoleSpy.mockClear();
      const err = new Error("something broke");
      log.error("failure", err);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('"message":"something broke"');
      expect(output).toContain('"stack"');
    });

    it("passes non-Error values directly", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "error";
      const { createLogger } = await import("../core/logger.js");
      const log = createLogger("err");

      consoleSpy.mockClear();
      log.error("failure", { code: 42 });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('{"code":42}');
    });
  });

  describe("child()", () => {
    it("creates child logger with combined context", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const parent = createLogger("parent");
      const child = parent.child("child");

      consoleSpy.mockClear();
      child.info("hello");

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("[parent:child]");
    });

    it("child of child uses colon-separated context", async () => {
      vi.resetModules();
      process.env.LOG_LEVEL = "debug";
      const { createLogger } = await import("../core/logger.js");
      const parent = createLogger("a");
      const child = parent.child("b");
      const grandchild = child.child("c");

      consoleSpy.mockClear();
      grandchild.info("deep");

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("[a:b:c]");
    });
  });
});

describe("createLogger()", () => {
  it("returns a Logger instance with context", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "debug";
    const { createLogger } = await import("../core/logger.js");
    const log = createLogger("test-context");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.info("test");

    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("[test-context]");

    consoleSpy.mockRestore();
    delete process.env.LOG_LEVEL;
  });
});
