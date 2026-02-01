import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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
  WORKSPACES_FILE: "/mock/data/workspaces.json",
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("TTL Cleanup", () => {
  describe("session-manager", () => {
    let sessionManager: any;
    let mockExistsSync: any;

    beforeEach(async () => {
      vi.resetModules();
      const fs = await import("fs");
      mockExistsSync = vi.mocked(fs.existsSync);
      mockExistsSync.mockReturnValue(false);

      const mod = await import("../claude/session-manager.js");
      sessionManager = mod.sessionManager;
    });

    afterEach(() => {
      if (sessionManager) {
        sessionManager.stopCleanupTimer();
      }
    });

    it("removes sessions inactive for more than 24 hours", () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
      const recentDate = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago

      // Add old session
      sessionManager.add({
        sessionId: "old-session",
        projectName: "old-proj",
        directory: "/tmp/old",
        slackChannelId: "C111",
        slackThreadTs: "1111.111",
        startedAt: oldDate,
        lastActivityAt: oldDate,
        autopilot: false,
      });

      // Add recent session
      sessionManager.add({
        sessionId: "recent-session",
        projectName: "recent-proj",
        directory: "/tmp/recent",
        slackChannelId: "C222",
        slackThreadTs: "2222.222",
        startedAt: recentDate,
        lastActivityAt: recentDate,
        autopilot: false,
      });

      expect(sessionManager.getActiveCount()).toBe(2);

      // Run cleanup
      const cleanedCount = sessionManager.runCleanup();

      expect(cleanedCount).toBe(1);
      expect(sessionManager.getActiveCount()).toBe(1);
      expect(sessionManager.get("old-session")).toBeUndefined();
      expect(sessionManager.get("recent-session")).toBeDefined();
    });

    it("does not remove sessions with recent activity", () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 23 * 60 * 60 * 1000); // 23 hours ago

      sessionManager.add({
        sessionId: "active-session",
        projectName: "active-proj",
        directory: "/tmp/active",
        slackChannelId: "C333",
        slackThreadTs: "3333.333",
        startedAt: recentDate,
        lastActivityAt: recentDate,
        autopilot: false,
      });

      expect(sessionManager.getActiveCount()).toBe(1);

      const cleanedCount = sessionManager.runCleanup();

      expect(cleanedCount).toBe(0);
      expect(sessionManager.getActiveCount()).toBe(1);
    });
  });

  describe("workspace-store", () => {
    let addWorkspace: any;
    let getWorkspace: any;
    let runCleanup: any;
    let stopCleanupTimer: any;
    let mockExistsSync: any;

    beforeEach(async () => {
      vi.resetModules();
      const fs = await import("fs");
      mockExistsSync = vi.mocked(fs.existsSync);
      mockExistsSync.mockReturnValue(false);

      const mod = await import("../stores/workspace-store.js");
      addWorkspace = mod.addWorkspace;
      getWorkspace = mod.getWorkspace;
      runCleanup = mod.runCleanup;
      stopCleanupTimer = mod.stopCleanupTimer;
    });

    afterEach(() => {
      if (stopCleanupTimer) {
        stopCleanupTimer();
      }
    });

    it("removes workspaces older than 24 hours", () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
      const recentDate = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago

      // Add old workspace
      addWorkspace("old-thread", {
        directory: "/tmp/old",
        projectName: "old-proj",
        channelId: "C111",
        createdAt: oldDate,
      });

      // Add recent workspace
      addWorkspace("recent-thread", {
        directory: "/tmp/recent",
        projectName: "recent-proj",
        channelId: "C222",
        createdAt: recentDate,
      });

      expect(getWorkspace("old-thread")).toBeDefined();
      expect(getWorkspace("recent-thread")).toBeDefined();

      // Run cleanup
      const cleanedCount = runCleanup();

      expect(cleanedCount).toBe(1);
      expect(getWorkspace("old-thread")).toBeUndefined();
      expect(getWorkspace("recent-thread")).toBeDefined();
    });

    it("handles workspaces without createdAt (legacy data)", () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 1 * 60 * 60 * 1000);

      // Add workspace without createdAt (simulating legacy data)
      addWorkspace("legacy-thread", {
        directory: "/tmp/legacy",
        projectName: "legacy-proj",
        channelId: "C111",
      } as any);

      // Add recent workspace
      addWorkspace("recent-thread", {
        directory: "/tmp/recent",
        projectName: "recent-proj",
        channelId: "C222",
        createdAt: recentDate,
      });

      // Run cleanup - should not crash and should not remove legacy entry
      const cleanedCount = runCleanup();

      expect(cleanedCount).toBe(0);
      expect(getWorkspace("legacy-thread")).toBeDefined();
      expect(getWorkspace("recent-thread")).toBeDefined();
    });
  });

  describe("multi-select-state", () => {
    let initState: any;
    let getState: any;
    let runCleanup: any;
    let stopCleanupTimer: any;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import("../stores/multi-select-state.js");
      initState = mod.initState;
      getState = mod.getState;
      runCleanup = mod.runCleanup;
      stopCleanupTimer = mod.stopCleanupTimer;
    });

    afterEach(() => {
      if (stopCleanupTimer) {
        stopCleanupTimer();
      }
    });

    it("removes states older than 1 hour", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Create state
      initState({
        projectName: "test-proj",
        messageId: "msg-1",
        options: [{ label: "Option 1", value: "1" }],
        questionText: "Test question",
      });

      expect(getState("test-proj", "msg-1")).toBeDefined();

      // Advance time by 61 minutes
      vi.advanceTimersByTime(61 * 60 * 1000);

      // Run cleanup
      const cleanedCount = runCleanup();

      expect(cleanedCount).toBe(1);
      expect(getState("test-proj", "msg-1")).toBeNull();

      vi.useRealTimers();
    });

    it("does not remove recent states", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      initState({
        projectName: "test-proj",
        messageId: "msg-1",
        options: [{ label: "Option 1", value: "1" }],
        questionText: "Test question",
      });

      // Advance time by 59 minutes (less than 1 hour)
      vi.advanceTimersByTime(59 * 60 * 1000);

      const cleanedCount = runCleanup();

      expect(cleanedCount).toBe(0);
      expect(getState("test-proj", "msg-1")).toBeDefined();

      vi.useRealTimers();
    });
  });

  describe("pending-questions", () => {
    let initPendingBatch: any;
    let hasPendingBatch: any;
    let runCleanup: any;
    let stopCleanupTimer: any;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import("../stores/pending-questions.js");
      initPendingBatch = mod.initPendingBatch;
      hasPendingBatch = mod.hasPendingBatch;
      runCleanup = mod.runCleanup;
      stopCleanupTimer = mod.stopCleanupTimer;
    });

    afterEach(() => {
      if (stopCleanupTimer) {
        stopCleanupTimer();
      }
    });

    it("removes batches older than 1 hour", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Create batch
      initPendingBatch(
        "thread-1",
        [
          { question: "Q1", options: [], multiSelect: false },
          { question: "Q2", options: [], multiSelect: false },
        ],
        "test-proj",
        "C123"
      );

      expect(hasPendingBatch("thread-1")).toBe(true);

      // Advance time by 61 minutes
      vi.advanceTimersByTime(61 * 60 * 1000);

      // Run cleanup
      const cleanedCount = runCleanup();

      expect(cleanedCount).toBe(1);
      expect(hasPendingBatch("thread-1")).toBe(false);

      vi.useRealTimers();
    });

    it("does not remove recent batches", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      initPendingBatch(
        "thread-1",
        [{ question: "Q1", options: [], multiSelect: false }],
        "test-proj",
        "C123"
      );

      // Advance time by 59 minutes
      vi.advanceTimersByTime(59 * 60 * 1000);

      const cleanedCount = runCleanup();

      expect(cleanedCount).toBe(0);
      expect(hasPendingBatch("thread-1")).toBe(true);

      vi.useRealTimers();
    });
  });
});
