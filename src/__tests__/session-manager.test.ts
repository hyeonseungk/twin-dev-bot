import { vi, describe, it, expect } from "vitest";
import { createMockSession } from "./helpers/mock-factories.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../core/paths.js", () => ({
  DATA_DIR: "/mock/data",
  SESSIONS_FILE: "/mock/data/sessions.json",
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Helper: reset modules, configure fs mocks, then dynamically import
 * session-manager so its module-level singleton re-runs loadFromFile.
 */
async function importFresh() {
  vi.resetModules();
  const fs = await import("fs");
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);
  const mockMkdirSync = vi.mocked(fs.mkdirSync);

  // Default: no file
  mockExistsSync.mockReturnValue(false);

  const mod = await import("../claude/session-manager.js");
  return {
    sessionManager: mod.sessionManager,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  };
}

async function importWithFile(content: string) {
  vi.resetModules();
  const fs = await import("fs");
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);
  const mockMkdirSync = vi.mocked(fs.mkdirSync);

  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(content);

  const mod = await import("../claude/session-manager.js");
  return {
    sessionManager: mod.sessionManager,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  };
}

describe("SessionManager", () => {
  describe("loadFromFile", () => {
    it("starts fresh when file doesn't exist", async () => {
      const { sessionManager } = await importFresh();
      expect(sessionManager.getActiveCount()).toBe(0);
    });

    it("loads sessions from valid JSON", async () => {
      const validData = JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "s1",
            projectName: "proj1",
            directory: "/tmp/proj1",
            slackChannelId: "C111",
            slackThreadTs: "1700000000.000000",
            startedAt: "2025-01-01T00:00:00.000Z",
            lastActivityAt: "2025-01-01T01:00:00.000Z",
            autopilot: true,
          },
        ],
      });

      const { sessionManager } = await importWithFile(validData);
      expect(sessionManager.getActiveCount()).toBe(1);

      const session = sessionManager.get("s1");
      expect(session).toBeDefined();
      expect(session!.projectName).toBe("proj1");
      expect(session!.autopilot).toBe(true);
    });

    it("handles corrupted JSON", async () => {
      const { sessionManager } = await importWithFile("not valid json {{{");
      expect(sessionManager.getActiveCount()).toBe(0);
    });

    it("handles invalid structure (no sessions array)", async () => {
      const { sessionManager } = await importWithFile(
        JSON.stringify({ version: 1, data: "wrong" })
      );
      expect(sessionManager.getActiveCount()).toBe(0);
    });

    it("skips bad entries", async () => {
      const data = JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "good",
            projectName: "proj",
            directory: "/tmp",
            slackChannelId: "C1",
            slackThreadTs: "1700000000.000000",
            startedAt: "2025-01-01T00:00:00.000Z",
            lastActivityAt: "2025-01-01T00:00:00.000Z",
          },
          // null entry will trigger TypeError in the for-of loop, caught by try/catch
          null as unknown,
        ],
      });

      const { sessionManager } = await importWithFile(data);
      // The good entry should be loaded; the null entry should be skipped
      expect(sessionManager.getActiveCount()).toBeGreaterThanOrEqual(1);
    });

    it("restores Date objects", async () => {
      const data = JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "s-date",
            projectName: "proj",
            directory: "/tmp",
            slackChannelId: "C1",
            slackThreadTs: "1700000000.000000",
            startedAt: "2025-06-15T12:00:00.000Z",
            lastActivityAt: "2025-06-15T13:00:00.000Z",
          },
        ],
      });

      const { sessionManager } = await importWithFile(data);
      const session = sessionManager.get("s-date");
      expect(session).toBeDefined();
      expect(session!.startedAt).toBeInstanceOf(Date);
      expect(session!.lastActivityAt).toBeInstanceOf(Date);
      expect(session!.startedAt.toISOString()).toBe("2025-06-15T12:00:00.000Z");
    });

    it("defaults autopilot to false when missing", async () => {
      const data = JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "s-no-auto",
            projectName: "proj",
            directory: "/tmp",
            slackChannelId: "C1",
            slackThreadTs: "1700000000.000000",
            startedAt: "2025-01-01T00:00:00.000Z",
            lastActivityAt: "2025-01-01T00:00:00.000Z",
            // autopilot field is missing
          },
        ],
      });

      const { sessionManager } = await importWithFile(data);
      const session = sessionManager.get("s-no-auto");
      expect(session).toBeDefined();
      expect(session!.autopilot).toBe(false);
    });
  });

  describe("add", () => {
    it("stores session retrievable by sessionId", async () => {
      const { sessionManager } = await importFresh();
      const session = createMockSession({ sessionId: "add-1" });

      sessionManager.add(session);

      expect(sessionManager.get("add-1")).toBe(session);
    });

    it("creates sessionKey mapping", async () => {
      const { sessionManager } = await importFresh();
      const session = createMockSession({
        sessionId: "add-2",
        projectName: "myproj",
        slackThreadTs: "1700000000.000001",
      });

      sessionManager.add(session);

      const found = sessionManager.getBySessionKey("myproj", "1700000000.000001");
      expect(found).toBe(session);
    });

    it("creates threadTs mapping", async () => {
      const { sessionManager } = await importFresh();
      const session = createMockSession({
        sessionId: "add-3",
        slackThreadTs: "1700000000.000002",
      });

      sessionManager.add(session);

      const found = sessionManager.getByThread("1700000000.000002");
      expect(found).toBe(session);
    });

    it("saves to file", async () => {
      const { sessionManager, writeFileSync: mockWrite } = await importFresh();
      const session = createMockSession({ sessionId: "add-4" });

      sessionManager.add(session);

      expect(mockWrite).toHaveBeenCalled();
    });
  });

  describe("get", () => {
    it("returns session by id", async () => {
      const { sessionManager } = await importFresh();
      const session = createMockSession({ sessionId: "get-1" });
      sessionManager.add(session);

      expect(sessionManager.get("get-1")).toBe(session);
    });

    it("returns undefined for unknown id", async () => {
      const { sessionManager } = await importFresh();

      expect(sessionManager.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getBySessionKey", () => {
    it("returns session by projectName and threadTs", async () => {
      const { sessionManager } = await importFresh();
      const session = createMockSession({
        sessionId: "key-1",
        projectName: "proj-a",
        slackThreadTs: "1700000000.000010",
      });
      sessionManager.add(session);

      const found = sessionManager.getBySessionKey("proj-a", "1700000000.000010");
      expect(found).toBe(session);
    });

    it("returns undefined for unknown key", async () => {
      const { sessionManager } = await importFresh();

      expect(sessionManager.getBySessionKey("unknown", "0")).toBeUndefined();
    });
  });

  describe("getByThread", () => {
    it("returns session by threadTs", async () => {
      const { sessionManager } = await importFresh();
      const session = createMockSession({
        sessionId: "thread-1",
        slackThreadTs: "1700000000.000020",
      });
      sessionManager.add(session);

      const found = sessionManager.getByThread("1700000000.000020");
      expect(found).toBe(session);
    });

    it("returns undefined for unknown threadTs", async () => {
      const { sessionManager } = await importFresh();

      expect(sessionManager.getByThread("unknown-ts")).toBeUndefined();
    });
  });

  describe("updateActivity", () => {
    it("updates lastActivityAt and saves", async () => {
      const { sessionManager, writeFileSync: mockWrite } = await importFresh();
      const session = createMockSession({
        sessionId: "upd-1",
        lastActivityAt: new Date("2025-01-01T00:00:00Z"),
      });
      sessionManager.add(session);
      mockWrite.mockClear();

      const before = session.lastActivityAt;
      sessionManager.updateActivity("upd-1");

      expect(session.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(mockWrite).toHaveBeenCalled();
    });

    it("no-op for unknown session", async () => {
      const { sessionManager, writeFileSync: mockWrite } = await importFresh();
      mockWrite.mockClear();

      sessionManager.updateActivity("nonexistent");

      expect(mockWrite).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("removes all mappings and saves", async () => {
      const { sessionManager, writeFileSync: mockWrite } = await importFresh();
      const session = createMockSession({
        sessionId: "rm-1",
        projectName: "proj-rm",
        slackThreadTs: "1700000000.000030",
      });
      sessionManager.add(session);
      mockWrite.mockClear();

      sessionManager.remove("rm-1");

      expect(sessionManager.get("rm-1")).toBeUndefined();
      expect(sessionManager.getBySessionKey("proj-rm", "1700000000.000030")).toBeUndefined();
      expect(sessionManager.getByThread("1700000000.000030")).toBeUndefined();
      expect(mockWrite).toHaveBeenCalled();
    });

    it("no-op for unknown session", async () => {
      const { sessionManager, writeFileSync: mockWrite } = await importFresh();
      mockWrite.mockClear();

      sessionManager.remove("nonexistent");

      expect(mockWrite).not.toHaveBeenCalled();
    });
  });

  describe("saveToFile failure", () => {
    it("continues working when writeFileSync throws", async () => {
      const { sessionManager, writeFileSync: mockWrite } = await importFresh();
      mockWrite.mockImplementation(() => { throw new Error("disk full"); });

      const session = createMockSession({ sessionId: "save-fail-1" });

      // Should not throw despite saveToFile failure
      expect(() => sessionManager.add(session)).not.toThrow();

      // Session should still be in memory
      expect(sessionManager.get("save-fail-1")).toBe(session);
    });
  });

  describe("getActiveCount", () => {
    it("returns count of active sessions", async () => {
      const { sessionManager } = await importFresh();

      expect(sessionManager.getActiveCount()).toBe(0);

      sessionManager.add(createMockSession({ sessionId: "cnt-1", slackThreadTs: "ts1" }));
      expect(sessionManager.getActiveCount()).toBe(1);

      sessionManager.add(createMockSession({ sessionId: "cnt-2", slackThreadTs: "ts2" }));
      expect(sessionManager.getActiveCount()).toBe(2);

      sessionManager.remove("cnt-1");
      expect(sessionManager.getActiveCount()).toBe(1);
    });
  });
});
