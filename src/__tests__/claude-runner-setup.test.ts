import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

let mockRunner: EventEmitter & { currentSessionId: string | null; kill: ReturnType<typeof vi.fn>; stderrOutput: string };

vi.mock("../claude/claude-runner.js", () => ({
  runClaude: vi.fn(() => mockRunner),
}));
vi.mock("../claude/session-manager.js", () => ({
  sessionManager: { add: vi.fn(), updateActivity: vi.fn() },
}));
vi.mock("../slack/question-blocks.js", () => ({
  buildQuestionBlocks: vi.fn(() => []),
}));
vi.mock("../stores/multi-select-state.js", () => ({
  initState: vi.fn(),
}));
vi.mock("../utils/slack-message.js", () => ({
  postThreadMessage: vi.fn().mockResolvedValue({ success: true, ts: "status-ts" }),
}));
vi.mock("../i18n/index.js", () => ({ t: vi.fn((key: string) => key) }));

// Use a class instead of vi.fn().mockImplementation() to survive restoreMocks
const mockTrackerInstances: any[] = [];
vi.mock("../slack/progress-tracker.js", () => ({
  ProgressTracker: class MockProgressTracker {
    markReceived = vi.fn().mockResolvedValue(undefined);
    markWorking = vi.fn().mockResolvedValue(undefined);
    updateToolUse = vi.fn().mockResolvedValue(undefined);
    markCompleted = vi.fn().mockResolvedValue(undefined);
    markAutopilotContinue = vi.fn().mockResolvedValue(undefined);
    markPlanApproved = vi.fn().mockResolvedValue(undefined);
    markError = vi.fn().mockResolvedValue(undefined);
    markAskUser = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    _args: any;
    constructor(args: any) {
      this._args = args;
      mockTrackerInstances.push(this);
    }
  },
}));

vi.mock("../stores/workspace-store.js", () => ({
  removeWorkspace: vi.fn(),
}));
vi.mock("../stores/pending-questions.js", () => ({
  initPendingBatch: vi.fn(),
}));
vi.mock("../utils/safe-async.js", () => ({
  safeAsync: vi.fn((handler: Function) => handler),
}));
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../core/config.js", () => ({
  config: { inactivityTimeoutMinutes: 30, inactivityTimeoutMs: 30 * 60 * 1000 },
}));
vi.mock("../claude/active-runners.js", () => ({
  registerRunner: vi.fn(),
  unregisterRunner: vi.fn(),
  refreshActivity: vi.fn(),
}));
vi.mock("../stores/action-payload-store.js", () => ({
  setPayload: vi.fn(),
}));

import { setupClaudeRunner } from "../handlers/claude-runner-setup.js";
import { runClaude } from "../claude/claude-runner.js";
import { sessionManager } from "../claude/session-manager.js";
import { buildQuestionBlocks } from "../slack/question-blocks.js";
import { initState } from "../stores/multi-select-state.js";
import { postThreadMessage } from "../utils/slack-message.js";
import { ProgressTracker } from "../slack/progress-tracker.js";
import { removeWorkspace } from "../stores/workspace-store.js";
import { initPendingBatch } from "../stores/pending-questions.js";
import { createMockWebClient } from "./helpers/mock-factories.js";
import type { WebClient } from "@slack/web-api";

function flushMicrotasks() {
  return new Promise<void>((resolve) => process.nextTick(resolve));
}

function getLatestTracker() {
  return mockTrackerInstances[mockTrackerInstances.length - 1];
}

describe("setupClaudeRunner", () => {
  let client: WebClient;

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  it("throws when threadTs is falsy", () => {
    expect(() =>
      setupClaudeRunner({ client, ...baseOptions, threadTs: "" })
    ).toThrow("threadTs is required");
  });

  it("creates ProgressTracker and calls markReceived", () => {
    setupClaudeRunner({ client, ...baseOptions });

    const tracker = getLatestTracker();
    expect(tracker).toBeDefined();
    expect(tracker._args).toEqual({
      client,
      channelId: "C123",
      threadTs: "ts-parent",
      userMessageTs: undefined,
    });
    expect(tracker.markReceived).toHaveBeenCalled();
  });

  it("calls runClaude with correct options", () => {
    setupClaudeRunner({ client, ...baseOptions });

    expect(runClaude).toHaveBeenCalledWith({
      directory: "/home/user/project",
      prompt: "do something",
      sessionId: undefined,
    });
  });
});

describe("init event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("adds session for new (no sessionId in options)", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("init", { sessionId: "new-session-1", model: "claude" });
    await flushMicrotasks();

    expect(sessionManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "new-session-1",
        projectName: "test-project",
        directory: "/home/user/project",
        slackChannelId: "C123",
        slackThreadTs: "ts-parent",
      })
    );
  });

  it("removes workspace after new session is created", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("init", { sessionId: "new-session-1", model: "claude" });
    await flushMicrotasks();

    expect(removeWorkspace).toHaveBeenCalledWith("ts-parent");
  });

  it("updates activity for resume (sessionId in options)", async () => {
    setupClaudeRunner({ client, ...baseOptions, sessionId: "existing-session" });

    mockRunner.emit("init", { sessionId: "existing-session", model: "claude" });
    await flushMicrotasks();

    expect(sessionManager.updateActivity).toHaveBeenCalledWith("existing-session");
    expect(sessionManager.add).not.toHaveBeenCalled();
  });

  it("does not remove workspace on resume", async () => {
    setupClaudeRunner({ client, ...baseOptions, sessionId: "existing-session" });

    mockRunner.emit("init", { sessionId: "existing-session", model: "claude" });
    await flushMicrotasks();

    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it("calls markWorking", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("init", { sessionId: "s1" });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.markWorking).toHaveBeenCalled();
  });
});

describe("text event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers text and flushes after 2 seconds", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("text", { text: "Here is the output" });
    await flushMicrotasks();

    // Not sent immediately (buffered)
    expect(postThreadMessage).not.toHaveBeenCalled();

    // After 2 seconds, the buffer flushes
    await vi.advanceTimersByTimeAsync(2000);

    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "Here is the output",
      "ts-parent"
    );
  });

  it("batches multiple text events into one message", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("text", { text: "Part 1" });
    await flushMicrotasks();
    mockRunner.emit("text", { text: "Part 2" });
    await flushMicrotasks();

    // After 2 seconds, both parts are sent as one message
    await vi.advanceTimersByTimeAsync(2000);

    expect(postThreadMessage).toHaveBeenCalledTimes(1);
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "Part 1\nPart 2",
      "ts-parent"
    );
  });

  it("flushes buffer on result event", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("text", { text: "Some output" });
    await flushMicrotasks();

    // Result event should flush the buffer
    mockRunner.emit("result", { costUsd: 0.01 });
    await flushMicrotasks();

    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "Some output",
      "ts-parent"
    );
  });

  it("skips empty text", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("text", { text: "   " });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);

    expect(postThreadMessage).not.toHaveBeenCalled();
  });
});

describe("toolUse event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("calls updateToolUse for non-AskUserQuestion", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("toolUse", { toolName: "ReadFile", input: {} });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.updateToolUse).toHaveBeenCalledWith("ReadFile");
  });

  it("ignores AskUserQuestion", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("toolUse", { toolName: "AskUserQuestion", input: {} });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.updateToolUse).not.toHaveBeenCalled();
  });

  it("ignores ExitPlanMode", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("toolUse", { toolName: "ExitPlanMode", input: {} });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.updateToolUse).not.toHaveBeenCalled();
  });
});

describe("exitPlanMode event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("kills runner and resumes with plan approved prompt", async () => {
    const runClaudeMock = vi.mocked(runClaude);

    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("exitPlanMode", {});
    await flushMicrotasks();

    expect(mockRunner.kill).toHaveBeenCalled();
    // setupClaudeRunner called recursively
    expect(runClaudeMock).toHaveBeenCalledTimes(2);
  });

  it("marks old tracker as plan approved before resuming", async () => {
    setupClaudeRunner({ client, ...baseOptions });
    const firstTracker = getLatestTracker();

    mockRunner.emit("exitPlanMode", {});
    await flushMicrotasks();

    expect(firstTracker.markPlanApproved).toHaveBeenCalled();
    expect(firstTracker.markCompleted).not.toHaveBeenCalled();
  });

  it("preserves autopilot flag on resume", async () => {
    const runClaudeMock = vi.mocked(runClaude);

    setupClaudeRunner({ client, ...baseOptions, autopilot: true });

    mockRunner.emit("exitPlanMode", {});
    await flushMicrotasks();

    // Second call should pass autopilot: true
    expect(runClaudeMock).toHaveBeenCalledTimes(2);
  });

  it("notifies Slack when sessionId is null", async () => {
    mockRunner.currentSessionId = null;
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("exitPlanMode", {});
    await flushMicrotasks();

    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.autopilotNoSession",
      "ts-parent"
    );
  });
});

describe("askUser - normal", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("inits multiSelect state when needed", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          {
            question: "Pick many",
            header: "Multi",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: true,
          },
        ],
      },
    });
    await flushMicrotasks();

    expect(initState).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "test-project",
        options: [{ label: "A" }, { label: "B" }],
        questionText: "Pick many",
        header: "Multi",
      })
    );
  });

  it("posts question blocks", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Choose one", options: [{ label: "A" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(buildQuestionBlocks).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "ts-parent",
      })
    );
  });

  it("calls markAskUser", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [{ question: "Q?", options: [{ label: "A" }] }],
      },
    });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.markAskUser).toHaveBeenCalled();
  });

  it("kills runner", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [{ question: "Q?", options: [{ label: "A" }] }],
      },
    });
    await flushMicrotasks();

    expect(mockRunner.kill).toHaveBeenCalled();
  });
});

describe("askUser - autopilot", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
    autopilot: true,
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("auto-selects first option", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Pick one", options: [{ label: "Option A" }, { label: "Option B" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(buildQuestionBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        isSubmitted: true,
      })
    );
  });

  it("posts completed blocks", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Pick one", options: [{ label: "Option A" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "ts-parent",
      })
    );
  });

  it("kills runner and resumes", async () => {
    const runClaudeMock = vi.mocked(runClaude);

    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Pick one", options: [{ label: "Option A" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(mockRunner.kill).toHaveBeenCalled();
    // setupClaudeRunner is called recursively -- runClaude is called again
    // First call is from the initial setupClaudeRunner, second is from the autopilot resume
    expect(runClaudeMock).toHaveBeenCalledTimes(2);
  });

  it("marks old tracker as autopilot-continue before resuming", async () => {
    setupClaudeRunner({ client, ...baseOptions });
    const firstTracker = getLatestTracker();

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Pick one", options: [{ label: "Option A" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(firstTracker.markAutopilotContinue).toHaveBeenCalled();
    expect(firstTracker.markCompleted).not.toHaveBeenCalled();
  });

  it("notifies Slack when sessionId is null", async () => {
    mockRunner.currentSessionId = null;
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Pick one", options: [{ label: "Option A" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.autopilotNoSession",
      "ts-parent"
    );
  });
});

describe("result event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("calls markCompleted", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("result", { costUsd: 0.0123 });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.markCompleted).toHaveBeenCalled();
  });
});

describe("error event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("posts error message", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("error", { message: "Something went wrong" });
    await flushMicrotasks();

    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.errorOccurred",
      "ts-parent"
    );
  });

  it("calls markError", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("error", { message: "Something went wrong" });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.markError).toHaveBeenCalledWith("runner.errorOccurred");
  });

  it("shows friendly message when claude CLI is not found (ENOENT)", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    const enoentError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    mockRunner.emit("error", enoentError);
    await flushMicrotasks();

    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.claudeNotFound",
      "ts-parent"
    );

    const tracker = getLatestTracker();
    expect(tracker.markError).toHaveBeenCalledWith("runner.claudeNotFound");
  });
});

describe("exit event", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("does nothing on null exit code (intentional kill)", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("exit", null);
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.markError).not.toHaveBeenCalled();
    expect(tracker.markCompleted).not.toHaveBeenCalled();
  });

  it("posts error and marks tracker on non-zero exit (no stderr)", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("exit", 1);
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.exitError",
      "ts-parent"
    );
    expect(tracker.markError).toHaveBeenCalled();
  });

  it("includes stderr in error message on non-zero exit", async () => {
    setupClaudeRunner({ client, ...baseOptions });
    mockRunner.stderrOutput = "Error: API key expired";

    mockRunner.emit("exit", 1);
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.exitError",
      "ts-parent"
    );
    expect(tracker.markError).toHaveBeenCalled();
  });

  it("does nothing on exit code 0 after result event", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("result", { costUsd: 0.01 });
    await flushMicrotasks();

    const tracker = getLatestTracker();
    vi.mocked(tracker.markCompleted).mockClear();

    mockRunner.emit("exit", 0);
    await flushMicrotasks();

    // markCompleted should NOT be called again by exit handler
    expect(tracker.markCompleted).not.toHaveBeenCalled();
    expect(tracker.markError).not.toHaveBeenCalled();
  });

  it("calls markCompleted on exit code 0 without result event", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("exit", 0);
    await flushMicrotasks();

    const tracker = getLatestTracker();
    expect(tracker.markCompleted).toHaveBeenCalled();
    expect(tracker.markError).not.toHaveBeenCalled();
  });
});

describe("askUser - multiple questions (normal mode)", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("initializes pending batch when questions.length > 1", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "A" }] },
          { question: "Q2?", header: "H2", options: [{ label: "B" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(initPendingBatch).toHaveBeenCalledWith(
      "ts-parent",
      expect.arrayContaining([
        expect.objectContaining({ question: "Q1?" }),
        expect.objectContaining({ question: "Q2?" }),
      ]),
      "test-project",
      "C123",
    );
  });

  it("does NOT initialize pending batch for single question", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Q1?", options: [{ label: "A" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(initPendingBatch).not.toHaveBeenCalled();
  });

  it("still posts first question and kills runner for multiple questions", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Q1?", options: [{ label: "A" }] },
          { question: "Q2?", options: [{ label: "B" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(buildQuestionBlocks).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "ts-parent",
      })
    );
    expect(mockRunner.kill).toHaveBeenCalled();
  });
});

describe("askUser - multiple questions (autopilot)", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
    autopilot: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-answers all questions and resumes with combined prompt", async () => {
    const runClaudeMock = vi.mocked(runClaude);

    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Which lib?", header: "Library", options: [{ label: "React" }, { label: "Vue" }] },
          { question: "Which style?", header: "Style", options: [{ label: "Tailwind" }, { label: "CSS" }] },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(mockRunner.kill).toHaveBeenCalled();
    // Second call to runClaude (resume) should have combined prompt
    expect(runClaudeMock).toHaveBeenCalledTimes(2);
    expect(runClaudeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: "[Library]: React\n[Style]: Tailwind",
      })
    );
  });

  it("does not use pending batch for autopilot", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("askUser", {
      input: {
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "A" }] },
          { question: "Q2?", header: "H2", options: [{ label: "B" }] },
        ],
      },
    });
    await flushMicrotasks();

    expect(initPendingBatch).not.toHaveBeenCalled();
  });
});

describe("race condition: process exits during askUser handling", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("aborts askUser when process exits with error during handling (normal mode)", async () => {
    setupClaudeRunner({ client, ...baseOptions });

    // 버퍼에 텍스트를 먼저 넣어서 flush 시 실제 await가 발생하도록 함
    // (빈 버퍼는 동기 반환하여 yield point가 생기지 않음)
    mockRunner.emit("text", { text: "some output before question" });

    // askUser와 exit을 연속 emit — askUser가 flush를 await하는 동안 exit이 끼어듦
    mockRunner.emit("askUser", {
      input: {
        questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      },
    });
    mockRunner.emit("exit", 1);
    await flushMicrotasks();

    const tracker = getLatestTracker();
    // exit 핸들러가 에러 메시지를 보내야 함
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.exitError",
      "ts-parent"
    );
    expect(tracker.markError).toHaveBeenCalled();
    // askUser 핸들러가 질문을 Slack에 보내지 않아야 함
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(tracker.markAskUser).not.toHaveBeenCalled();
  });

  it("aborts askUser autopilot resume when process exits during handling", async () => {
    const runClaudeMock = vi.mocked(runClaude);

    setupClaudeRunner({ client, ...baseOptions, autopilot: true });

    // 버퍼에 텍스트를 먼저 넣어서 flush 시 실제 await가 발생하도록 함
    mockRunner.emit("text", { text: "some output before question" });

    mockRunner.emit("askUser", {
      input: {
        questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      },
    });
    mockRunner.emit("exit", 1);
    await flushMicrotasks();

    // exit 핸들러가 에러를 처리해야 함
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.exitError",
      "ts-parent"
    );
    // autopilot이 새 runner를 시작하지 않아야 함 (초기 1회만)
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
  });
});

describe("race condition: process exits during exitPlanMode handling", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    threadTs: "ts-parent",
    directory: "/home/user/project",
    projectName: "test-project",
    prompt: "do something",
  };

  beforeEach(() => {
    client = createMockWebClient();
    mockRunner = Object.assign(new EventEmitter(), {
      currentSessionId: "session-123",
      kill: vi.fn(),
      stderrOutput: "",
    });
    mockTrackerInstances.length = 0;
  });

  it("aborts exitPlanMode resume when process exits with error during handling", async () => {
    const runClaudeMock = vi.mocked(runClaude);

    setupClaudeRunner({ client, ...baseOptions });

    mockRunner.emit("exitPlanMode", {});
    mockRunner.emit("exit", 1);
    await flushMicrotasks();

    // exit 핸들러가 에러 메시지를 보내야 함
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "runner.exitError",
      "ts-parent"
    );
    const tracker = getLatestTracker();
    expect(tracker.markError).toHaveBeenCalled();
    // exitPlanMode가 새 runner를 시작하지 않아야 함 (초기 1회만)
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
  });
});
