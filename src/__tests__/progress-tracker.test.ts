import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../utils/slack-rate-limit.js", () => ({
  withRetry: vi.fn((fn: Function) => fn()),
}));
vi.mock("../utils/slack-message.js", () => ({
  addReaction: vi.fn().mockResolvedValue(undefined),
  removeReaction: vi.fn().mockResolvedValue(undefined),
  postThreadMessage: vi.fn().mockResolvedValue({ success: true, ts: "status-ts" }),
}));

vi.mock("../i18n/index.js", () => ({
  t: vi.fn((key: string, params?: Record<string, unknown>) => {
    if (params) return `${key}:${JSON.stringify(params)}`;
    return key;
  }),
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ProgressTracker } from "../slack/progress-tracker.js";
import { addReaction, removeReaction, postThreadMessage } from "../utils/slack-message.js";
import { t } from "../i18n/index.js";
import { createMockWebClient } from "./helpers/mock-factories.js";
import type { WebClient } from "@slack/web-api";

const mockAddReaction = vi.mocked(addReaction);
const mockRemoveReaction = vi.mocked(removeReaction);
const mockPostThreadMessage = vi.mocked(postThreadMessage);
const mockT = vi.mocked(t);

describe("ProgressTracker", () => {
  let client: WebClient;
  let tracker: ProgressTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));

    client = createMockWebClient();
    tracker = new ProgressTracker({
      client,
      channelId: "C123",
      threadTs: "1700000000.000000",
      userMessageTs: "1700000000.000001",
    });

    vi.clearAllMocks();
    // Re-setup mock return values after clearAllMocks
    mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
    mockAddReaction.mockResolvedValue(undefined);
    mockRemoveReaction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("markReceived", () => {
    it("adds eyes reaction to userMessageTs", async () => {
      await tracker.markReceived();

      expect(mockAddReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "eyes"
      );
    });

    it("does nothing when userMessageTs not provided", async () => {
      const trackerNoMsg = new ProgressTracker({
        client,
        channelId: "C123",
        threadTs: "1700000000.000000",
        // userMessageTs not provided
      });

      await trackerNoMsg.markReceived();

      expect(mockAddReaction).not.toHaveBeenCalled();
    });
  });

  describe("markWorking", () => {
    it("swaps eyes to gear reaction", async () => {
      // First set up the "eyes" reaction via markReceived
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();

      expect(mockRemoveReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "eyes"
      );
      expect(mockAddReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "gear"
      );
    });

    it("posts status message", async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();

      expect(mockPostThreadMessage).toHaveBeenCalledWith(
        client,
        "C123",
        "progress.working",
        "1700000000.000000"
      );
    });

    it("stores statusMessageTs", async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "new-status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();

      // Subsequent updates should use chat.update with stored ts
      vi.advanceTimersByTime(30000);
      await tracker.updateToolUse("Read");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ts: "new-status-ts",
        })
      );
    });
  });

  describe("updateToolUse", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
    });

    it("updates status with known tool description", async () => {
      // When t(key) returns a different string than the key, the tool is "known"
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        if (key === "progress.tool.Read") return "Reading file";
        if (key === "progress.tool.default") return "Working...";
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      vi.advanceTimersByTime(10000); // 10 seconds elapsed
      await tracker.updateToolUse("Read");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Reading file"),
        })
      );
    });

    it("uses default for unknown tool", async () => {
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        // For unknown tool, t(key) returns the key itself
        if (key === "progress.tool.UnknownTool") return key;
        if (key === "progress.tool.default") return "Working on task";
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      await tracker.updateToolUse("UnknownTool");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Working on task"),
        })
      );
    });

    it("includes elapsed time", async () => {
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        if (key === "progress.tool.Read") return key; // unknown
        if (key === "progress.tool.default") return "Working";
        if (key === "progress.seconds") return `${(params as any)?.n}s`;
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      vi.advanceTimersByTime(15000); // 15 seconds
      await tracker.updateToolUse("Read");

      // The status message should include elapsed time in parens
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("15s"),
        })
      );
    });
  });

  describe("markCompleted", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);
    });

    it("swaps gear to white_check_mark", async () => {
      await tracker.markCompleted();

      expect(mockRemoveReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "gear"
      );
      expect(mockAddReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "white_check_mark"
      );
    });

    it("updates status with elapsed time", async () => {
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        if (key === "progress.seconds") return `${(params as any)?.n}s`;
        if (key === "progress.completed") {
          return `Completed: ${(params as any)?.elapsed}`;
        }
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      vi.advanceTimersByTime(45000); // 45 seconds
      await tracker.markCompleted();

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("45s"),
        })
      );
    });
  });

  describe("markError", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);
    });

    it("swaps gear to x", async () => {
      await tracker.markError("something failed");

      expect(mockRemoveReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "gear"
      );
      expect(mockAddReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "x"
      );
    });

    it("updates status with error message", async () => {
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        if (key === "progress.error") return `Error: ${(params as any)?.error}`;
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      await tracker.markError("process crashed");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("process crashed"),
        })
      );
    });
  });

  describe("markPlanApproved", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);
    });

    it("swaps gear to thumbsup", async () => {
      await tracker.markPlanApproved();

      expect(mockRemoveReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "gear"
      );
      expect(mockAddReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "thumbsup"
      );
    });

    it("updates status with planApproved text", async () => {
      await tracker.markPlanApproved();

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "progress.planApproved",
        })
      );
    });
  });

  describe("markAskUser", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);
    });

    it("swaps gear to raised_hand", async () => {
      await tracker.markAskUser();

      expect(mockRemoveReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "gear"
      );
      expect(mockAddReaction).toHaveBeenCalledWith(
        client,
        "C123",
        "1700000000.000001",
        "raised_hand"
      );
    });

    it("updates status with askUser text", async () => {
      await tracker.markAskUser();

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "progress.askUser",
        })
      );
    });
  });

  describe("updateToolUse throttling", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
    });

    it("sends first call immediately", async () => {
      await tracker.updateToolUse("Read");

      expect(client.chat.update).toHaveBeenCalledTimes(1);
    });

    it("throttles second rapid call", async () => {
      await tracker.updateToolUse("Read");
      vi.clearAllMocks();

      // 1 second later (within 3s throttle window)
      vi.advanceTimersByTime(1000);
      await tracker.updateToolUse("Write");

      // Should NOT have called chat.update for the second call
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("flushes throttled update after delay", async () => {
      await tracker.updateToolUse("Read");
      vi.clearAllMocks();

      // 1 second later
      vi.advanceTimersByTime(1000);
      await tracker.updateToolUse("Write");

      expect(client.chat.update).not.toHaveBeenCalled();

      // Advance remaining 4 seconds to trigger the pending timer
      await vi.advanceTimersByTimeAsync(4000);

      expect(client.chat.update).toHaveBeenCalledTimes(1);
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(":gear:"),
        })
      );
    });

    it("allows update after throttle window passes", async () => {
      await tracker.updateToolUse("Read");
      vi.clearAllMocks();

      // Advance past throttle window (5 seconds)
      vi.advanceTimersByTime(5000);
      await tracker.updateToolUse("Write");

      expect(client.chat.update).toHaveBeenCalledTimes(1);
    });

    it("markCompleted flushes pending update", async () => {
      await tracker.updateToolUse("Read");
      vi.clearAllMocks();
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      // Throttled call
      vi.advanceTimersByTime(1000);
      await tracker.updateToolUse("Write");

      // markCompleted should flush the pending update first, then update with completed status
      await tracker.markCompleted();

      // chat.update should have been called: once for flushed pending + once for completed
      expect(client.chat.update).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose", () => {
    beforeEach(async () => {
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);

      await tracker.markWorking();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
    });

    it("clears pending update timer", async () => {
      // Set up a throttled (pending) update
      await tracker.updateToolUse("Read");
      vi.clearAllMocks();

      vi.advanceTimersByTime(1000);
      await tracker.updateToolUse("Write");

      // Dispose before the timer fires
      tracker.dispose();

      // Advance past the throttle window
      await vi.advanceTimersByTimeAsync(5000);

      // The pending update should NOT have been flushed
      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("prevents timer callback from executing after dispose", async () => {
      // Set up a throttled (pending) update
      await tracker.updateToolUse("Read");
      vi.clearAllMocks();

      vi.advanceTimersByTime(1000);
      await tracker.updateToolUse("Write");

      // Dispose — even if clearTimeout has a race, the disposed guard prevents execution
      tracker.dispose();

      await vi.advanceTimersByTimeAsync(10000);

      expect(client.chat.update).not.toHaveBeenCalled();
    });

    it("is safe to call multiple times", () => {
      expect(() => {
        tracker.dispose();
        tracker.dispose();
      }).not.toThrow();
    });
  });

  describe("getElapsedText (private, tested indirectly)", () => {
    it("formats seconds when under 60s", async () => {
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        if (key === "progress.seconds") return `${(params as any)?.n}sec`;
        if (key === "progress.tool.SomeTool") return key; // unknown
        if (key === "progress.tool.default") return "Working";
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      // Need to set up status message first
      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);
      await tracker.markWorking();
      vi.clearAllMocks();

      vi.advanceTimersByTime(30000); // 30 seconds
      await tracker.updateToolUse("SomeTool");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("30sec"),
        })
      );
    });

    it("formats minutes+seconds when >= 60s", async () => {
      mockT.mockImplementation((key: string, params?: Record<string, unknown>) => {
        if (key === "progress.minutesSeconds")
          return `${(params as any)?.m}m${(params as any)?.s}s`;
        if (key === "progress.tool.SomeTool") return key; // unknown
        if (key === "progress.tool.default") return "Working";
        if (params) return `${key}:${JSON.stringify(params)}`;
        return key;
      });

      await tracker.markReceived();
      vi.clearAllMocks();
      mockPostThreadMessage.mockResolvedValue({ success: true, ts: "status-ts" });
      mockAddReaction.mockResolvedValue(undefined);
      mockRemoveReaction.mockResolvedValue(undefined);
      await tracker.markWorking();
      vi.clearAllMocks();

      vi.advanceTimersByTime(125000); // 2 minutes 5 seconds
      await tracker.updateToolUse("SomeTool");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("2m5s"),
        })
      );
    });
  });
});
