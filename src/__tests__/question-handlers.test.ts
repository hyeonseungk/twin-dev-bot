import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../claude/session-manager.js", () => ({
  sessionManager: { getByThread: vi.fn(), setAutopilot: vi.fn() },
}));
vi.mock("../utils/slack-message.js", () => ({
  updateSlackMessage: vi.fn().mockResolvedValue(undefined),
  updateSlackMessageWithMultiSelect: vi.fn().mockResolvedValue(undefined),
  postThreadMessage: vi.fn().mockResolvedValue({ success: true, ts: "msg-ts" }),
}));
vi.mock("../handlers/claude-runner-setup.js", () => ({
  setupClaudeRunner: vi.fn(),
}));
vi.mock("../stores/multi-select-state.js", () => ({
  toggleOption: vi.fn(),
  getSelectedOptions: vi.fn(() => [0, 2]),
  clearState: vi.fn(),
  initState: vi.fn(),
  getState: vi.fn(() => null),
}));
vi.mock("../i18n/index.js", () => ({ t: vi.fn((key: string) => key) }));
vi.mock("../claude/active-runners.js", () => ({
  isRunnerActive: vi.fn(() => false),
  killActiveRunner: vi.fn(),
}));
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../stores/pending-questions.js", () => ({
  hasPendingBatch: vi.fn(() => false),
  recordAnswerAndAdvance: vi.fn(),
  buildCombinedAnswer: vi.fn(),
  clearPendingBatch: vi.fn(),
}));
vi.mock("../slack/question-blocks.js", () => ({
  buildQuestionBlocks: vi.fn(() => []),
}));
vi.mock("../stores/action-payload-store.js", () => ({
  getPayload: vi.fn(),
  setPayload: vi.fn(),
  removePayload: vi.fn(),
}));
vi.mock("../stores/workspace-store.js", () => ({
  getWorkspace: vi.fn(),
}));

import { registerQuestionHandlers } from "../handlers/question-handlers.js";
import { sessionManager } from "../claude/session-manager.js";
import { updateSlackMessage, updateSlackMessageWithMultiSelect, postThreadMessage } from "../utils/slack-message.js";
import { setupClaudeRunner } from "../handlers/claude-runner-setup.js";
import { toggleOption, getSelectedOptions, clearState, getState } from "../stores/multi-select-state.js";
import { getWorkspace } from "../stores/workspace-store.js";
import {
  createMockApp,
  createMockWebClient,
  createMockSession,
} from "./helpers/mock-factories.js";
import {
  hasPendingBatch,
  recordAnswerAndAdvance,
  buildCombinedAnswer,
  clearPendingBatch,
} from "../stores/pending-questions.js";
import { isRunnerActive } from "../claude/active-runners.js";
import { buildQuestionBlocks } from "../slack/question-blocks.js";
import { initState } from "../stores/multi-select-state.js";
import type { SelectedOptionValue, TextInputButtonValue, TextInputModalMetadata, ToggleOptionValue, SubmitMultiSelectValue, StoredQuestionPayload } from "../types/index.js";
import { getPayload, setPayload } from "../stores/action-payload-store.js";

describe("registerQuestionHandlers", () => {
  it("registers all action and view handlers", () => {
    const app = createMockApp();
    registerQuestionHandlers(app as any);

    // 8 action handlers (4 original + 2 autopilot interrupt + 2 normal interrupt) + 1 view handler
    expect(app.action).toHaveBeenCalledTimes(8);
    expect(app.view).toHaveBeenCalledTimes(1);
    expect(app.view).toHaveBeenCalledWith("text_input_modal", expect.any(Function));
  });
});

describe("select_option handler", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers[`action:${/^select_option_\d+_\d+$/}`];
  }

  it("acknowledges action", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const ack = vi.fn();
    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "PostgreSQL",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack,
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_1", value: JSON.stringify(value) },
    });

    expect(ack).toHaveBeenCalled();
  });

  it("resumes Claude with selected label", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "PostgreSQL",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_1", value: JSON.stringify(value) },
    });

    expect(updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAnswer: "PostgreSQL",
        isSubmitted: true,
      })
    );
    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "PostgreSQL",
        sessionId: session.sessionId,
      })
    );
  });

  it("sends ephemeral notice when runner is already active", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(isRunnerActive).mockReturnValue(true);

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "PostgreSQL",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_1", value: JSON.stringify(value) },
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "error.alreadyProcessing",
      thread_ts: session.slackThreadTs,
    });

    vi.mocked(isRunnerActive).mockReturnValue(false);
  });

  it("returns early when value is missing", async () => {
    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
      },
      client,
      action: { action_id: "select_option_0_1", value: undefined },
    });

    expect(sessionManager.getByThread).not.toHaveBeenCalled();
    expect(setupClaudeRunner).not.toHaveBeenCalled();
  });

  it("returns early and sends ephemeral when session not found", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "PostgreSQL",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_1", value: JSON.stringify(value) },
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "session.expired",
      thread_ts: "thread-ts",
    });
  });
});

describe("text_input handler", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers[`action:${/^text_input_\d+$/}`];
  }

  it("acknowledges and opens modal", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const value: TextInputButtonValue = {
      questionIndex: 0,
      type: "text_input",
      projectName: "test-project",
      messageId: "msg-1",
    };

    const ack = vi.fn();
    await getHandler()({
      ack,
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
      },
      client,
      action: { action_id: "text_input_0", value: JSON.stringify(value) },
    });

    expect(ack).toHaveBeenCalled();
    expect(client.views.open).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: "trigger-123",
        view: expect.objectContaining({
          type: "modal",
          callback_id: "text_input_modal",
        }),
      })
    );
  });

  it("returns early and sends ephemeral when session not found", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);

    const value: TextInputButtonValue = {
      questionIndex: 0,
      type: "text_input",
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "text_input_0", value: JSON.stringify(value) },
    });

    expect(client.views.open).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "session.expiredUnknown",
      thread_ts: "thread-ts",
    });
  });
});

describe("text_input_modal view", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers["view:text_input_modal"];
  }

  it("acknowledges and resumes with answer", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const metadata: TextInputModalMetadata = {
      requestId: "test-project:msg-1",
      questionIndex: 0,
      channelId: "C123",
      messageTs: "msg-ts",
      threadTs: "thread-ts",
    };

    const ack = vi.fn();
    await getHandler()({
      ack,
      view: {
        private_metadata: JSON.stringify(metadata),
        state: {
          values: {
            answer_block: {
              answer_input: { value: "my custom answer" },
            },
          },
        },
      },
      client,
      body: { user: { id: "U123" } },
    });

    expect(ack).toHaveBeenCalled();
    expect(updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAnswer: "my custom answer",
        isSubmitted: true,
      })
    );
    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "my custom answer",
        sessionId: session.sessionId,
      })
    );
  });

  it("returns early on empty answer", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const metadata: TextInputModalMetadata = {
      requestId: "test-project:msg-1",
      questionIndex: 0,
      channelId: "C123",
      messageTs: "msg-ts",
      threadTs: "thread-ts",
    };

    await getHandler()({
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify(metadata),
        state: {
          values: {
            answer_block: {
              answer_input: { value: "   " },
            },
          },
        },
      },
      client,
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
  });

  it("returns early and sends ephemeral when session not found", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);

    const metadata: TextInputModalMetadata = {
      requestId: "test-project:msg-1",
      questionIndex: 0,
      channelId: "C123",
      messageTs: "msg-ts",
      threadTs: "thread-ts",
    };

    await getHandler()({
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify(metadata),
        state: {
          values: {
            answer_block: {
              answer_input: { value: "my answer" },
            },
          },
        },
      },
      client,
      body: { user: { id: "U123" } },
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "session.expired",
      thread_ts: "thread-ts",
    });
  });

  it("returns early when requestId has no colon separator", async () => {
    const metadata: TextInputModalMetadata = {
      requestId: "invalid-request-id-no-colon",
      questionIndex: 0,
      channelId: "C123",
      messageTs: "msg-ts",
      threadTs: "thread-ts",
    };

    await getHandler()({
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify(metadata),
        state: {
          values: {
            answer_block: {
              answer_input: { value: "my answer" },
            },
          },
        },
      },
      client,
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
    expect(sessionManager.getByThread).not.toHaveBeenCalled();
  });

  it("clears multi-select state on text input submission", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(clearState).mockClear();

    const metadata: TextInputModalMetadata = {
      requestId: "test-project:msg-1",
      questionIndex: 0,
      channelId: "C123",
      messageTs: "msg-ts",
      threadTs: "thread-ts",
    };

    await getHandler()({
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify(metadata),
        state: {
          values: {
            answer_block: {
              answer_input: { value: "my custom answer" },
            },
          },
        },
      },
      client,
      body: { user: { id: "U123" } },
    });

    expect(clearState).toHaveBeenCalledWith("test-project", "msg-1");
  });
});

describe("toggle_option handler", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers[`action:${/^toggle_option_\d+_\d+$/}`];
  }

  it("toggles option and updates message", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(getSelectedOptions).mockReturnValue([0, 2]);

    const value: ToggleOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "Option B",
      projectName: "test-project",
      messageId: "msg-1",
    };

    const ack = vi.fn();
    await getHandler()({
      ack,
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
      },
      client,
      action: { action_id: "toggle_option_0_1", value: JSON.stringify(value) },
    });

    expect(ack).toHaveBeenCalled();
    expect(toggleOption).toHaveBeenCalledWith("test-project", "msg-1", 1);
    expect(getSelectedOptions).toHaveBeenCalledWith("test-project", "msg-1");
    expect(updateSlackMessageWithMultiSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        ts: "msg-ts",
        projectName: "test-project",
        messageId: "msg-1",
        selectedOptionIndexes: [0, 2],
      })
    );
  });
});

describe("submit_multi_select handler", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers[`action:${/^submit_multi_select_\d+$/}`];
  }

  it("joins selected labels and resumes", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(getSelectedOptions).mockReturnValue([0, 2]);
    vi.mocked(getPayload).mockReturnValue({ questionText: "Pick many", header: undefined, optionLabels: ["Option A", "Option B", "Option C"] });

    const value: SubmitMultiSelectValue = {
      questionIndex: 0,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "submit_multi_select_0", value: JSON.stringify(value) },
    });

    expect(updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAnswer: "Option A, Option C",
        isSubmitted: true,
        question: expect.objectContaining({ multiSelect: true }),
      })
    );
    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Option A, Option C",
        sessionId: session.sessionId,
      })
    );
  });

  it("returns early when no options selected", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(getSelectedOptions).mockReturnValue([]);
    vi.mocked(getPayload).mockReturnValue({ questionText: "Pick many", header: undefined, optionLabels: ["Option A", "Option B"] });

    const value: SubmitMultiSelectValue = {
      questionIndex: 0,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "submit_multi_select_0", value: JSON.stringify(value) },
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
  });

  it("clears state after submission", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(getSelectedOptions).mockReturnValue([0]);
    vi.mocked(getPayload).mockReturnValue({ questionText: "Pick many", header: undefined, optionLabels: ["Option A"] });

    const value: SubmitMultiSelectValue = {
      questionIndex: 0,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "submit_multi_select_0", value: JSON.stringify(value) },
    });

    expect(clearState).toHaveBeenCalledWith("test-project", "msg-1");
  });
});

describe("pending questions in resumeClaudeWithAnswer", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
    vi.mocked(hasPendingBatch).mockReturnValue(false);
  });

  function getSelectHandler() {
    return app._handlers[`action:${/^select_option_\d+_\d+$/}`];
  }

  it("posts next question instead of resuming Claude when pending questions remain", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(hasPendingBatch).mockReturnValue(true);
    vi.mocked(recordAnswerAndAdvance).mockReturnValue({
      done: false,
      nextQuestion: { question: "Next Q?", header: "Next", options: [{ label: "X" }, { label: "Y" }], multiSelect: false },
      batch: { questions: [{} as any, {} as any], answers: ["A"], currentIndex: 1, projectName: "test-project", channelId: "C123", createdAt: Date.now() },
    });

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 0,
      label: "AnswerA",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getSelectHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_0", value: JSON.stringify(value) },
    });

    // Should update current message as answered
    expect(updateSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ selectedAnswer: "AnswerA", isSubmitted: true })
    );
    // Should post next question
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: session.slackThreadTs,
      })
    );
    expect(buildQuestionBlocks).toHaveBeenCalled();
    // Should NOT resume Claude
    expect(setupClaudeRunner).not.toHaveBeenCalled();
  });

  it("resumes Claude with combined answer when all pending questions answered", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(hasPendingBatch).mockReturnValue(true);
    vi.mocked(recordAnswerAndAdvance).mockReturnValue({
      done: true,
      batch: { questions: [{} as any, {} as any], answers: ["A", "B"], currentIndex: 2, projectName: "test-project", channelId: "C123", createdAt: Date.now() },
    });
    vi.mocked(buildCombinedAnswer).mockReturnValue("[H1]: A\n[H2]: B");

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 0,
      label: "B",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-2",
    };

    await getSelectHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_0", value: JSON.stringify(value) },
    });

    // Should resume Claude with combined answer
    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "[H1]: A\n[H2]: B",
        sessionId: session.sessionId,
      })
    );
    // Should clear pending batch
    expect(clearPendingBatch).toHaveBeenCalledWith(session.slackThreadTs);
  });

  it("initializes multi-select state for next question if multiSelect", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(hasPendingBatch).mockReturnValue(true);
    vi.mocked(recordAnswerAndAdvance).mockReturnValue({
      done: false,
      nextQuestion: {
        question: "Pick many",
        header: "Multi",
        options: [{ label: "X" }, { label: "Y" }],
        multiSelect: true,
      },
      batch: { questions: [{} as any, {} as any], answers: ["A"], currentIndex: 1, projectName: "test-project", channelId: "C123", createdAt: Date.now() },
    });

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 0,
      label: "AnswerA",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getSelectHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_0", value: JSON.stringify(value) },
    });

    expect(initState).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "test-project",
        options: [{ label: "X" }, { label: "Y" }],
        questionText: "Pick many",
        header: "Multi",
      })
    );
  });

  it("falls back to normal behavior when no pending batch", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(hasPendingBatch).mockReturnValue(false);

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 0,
      label: "SingleAnswer",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    await getSelectHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_0", value: JSON.stringify(value) },
    });

    // Should resume Claude directly with the single answer
    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "SingleAnswer",
        sessionId: session.sessionId,
      })
    );
    // Should not touch pending batch functions
    expect(recordAnswerAndAdvance).not.toHaveBeenCalled();
    expect(clearPendingBatch).not.toHaveBeenCalled();
  });
});

describe("resumeClaudeWithAnswer error notification", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  it("posts error message to thread when setupClaudeRunner throws", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(setupClaudeRunner).mockImplementation(() => { throw new Error("spawn failed"); });

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 0,
      label: "Option A",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    const handler = app._handlers[`action:${/^select_option_\d+_\d+$/}`];
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_0", value: JSON.stringify(value) },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "error.resumeFailed",
      thread_ts: session.slackThreadTs,
    });
  });

  it("posts error message to thread when updateSlackMessage rejects", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(updateSlackMessage).mockRejectedValueOnce(new Error("Slack API error"));

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 0,
      label: "Option A",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    const handler = app._handlers[`action:${/^select_option_\d+_\d+$/}`];
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_0", value: JSON.stringify(value) },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "error.resumeFailed",
      thread_ts: session.slackThreadTs,
    });
    // setupClaudeRunner should not have been called since updateSlackMessage failed first
    expect(setupClaudeRunner).not.toHaveBeenCalled();
  });
});

describe("error handling - ephemeral error notice", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  it("sends ephemeral error notice when select_option handler throws", async () => {
    // sessionManager.getByThread throwing (not returning undefined) triggers the outer catch
    vi.mocked(sessionManager.getByThread).mockImplementation(() => { throw new Error("unexpected"); });

    const value: SelectedOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "PostgreSQL",
      isMultiSelect: false,
      projectName: "test-project",
      messageId: "msg-1",
    };

    const handler = app._handlers[`action:${/^select_option_\d+_\d+$/}`];
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "select_option_0_1", value: JSON.stringify(value) },
    });

    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "error.actionFailed",
      thread_ts: "thread-ts",
    });
  });

  it("sends ephemeral error notice when toggle_option handler throws", async () => {
    vi.mocked(updateSlackMessageWithMultiSelect).mockRejectedValueOnce(new Error("update failed"));
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const value: ToggleOptionValue = {
      questionIndex: 0,
      optionIndex: 1,
      label: "Option B",
      projectName: "test-project",
      messageId: "msg-1",
    };

    const handler = app._handlers[`action:${/^toggle_option_\d+_\d+$/}`];
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts", thread_ts: "thread-ts" },
        trigger_id: "trigger-123",
        user: { id: "U123" },
      },
      client,
      action: { action_id: "toggle_option_0_1", value: JSON.stringify(value) },
    });

    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "error.actionFailed",
      thread_ts: "thread-ts",
    });
  });
});

describe("normal_interrupt_yes handler", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers["action:normal_interrupt_yes"];
  }

  it("posts session.notFound when neither session nor workspace exists", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);
    vi.mocked(getWorkspace).mockReturnValue(undefined);

    const interruptValue = JSON.stringify({
      threadTs: "thread-ts",
      channelId: "C123",
      projectName: "test-project",
    });

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts" },
        user: { id: "U123" },
      },
      client,
      action: { action_id: "normal_interrupt_yes", value: interruptValue },
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "session.notFound",
      "thread-ts",
    );
  });

  it("resumes with session when session exists", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(getPayload).mockReturnValue("user message text");

    const interruptValue = JSON.stringify({
      threadTs: session.slackThreadTs,
      channelId: "C123",
      projectName: "test-project",
    });

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts" },
        user: { id: "U123" },
      },
      client,
      action: { action_id: "normal_interrupt_yes", value: interruptValue },
    });

    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "user message text",
        sessionId: session.sessionId,
      })
    );
  });

  it("resumes with workspace when no session but workspace exists", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);
    vi.mocked(getWorkspace).mockReturnValue({
      directory: "/home/user/workspace",
      projectName: "workspace-proj",
      channelId: "C456",
      autopilot: false,
    });
    vi.mocked(getPayload).mockReturnValue("user message text");

    const interruptValue = JSON.stringify({
      threadTs: "thread-ts",
      channelId: "C123",
      projectName: "test-project",
    });

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts" },
        user: { id: "U123" },
      },
      client,
      action: { action_id: "normal_interrupt_yes", value: interruptValue },
    });

    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C456",
        directory: "/home/user/workspace",
        projectName: "workspace-proj",
        prompt: "user message text",
      })
    );
  });
});

describe("autopilot_interrupt_yes handler", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerQuestionHandlers(app as any);
  });

  function getHandler() {
    return app._handlers["action:autopilot_interrupt_yes"];
  }

  it("posts session.notFound when neither session nor workspace exists", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);
    vi.mocked(getWorkspace).mockReturnValue(undefined);

    const interruptValue = JSON.stringify({
      threadTs: "thread-ts",
      channelId: "C123",
      projectName: "test-project",
    });

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts" },
        user: { id: "U123" },
      },
      client,
      action: { action_id: "autopilot_interrupt_yes", value: interruptValue },
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "session.notFound",
      "thread-ts",
    );
  });

  it("resumes with session in non-autopilot mode when session exists", async () => {
    const session = createMockSession({ autopilot: true });
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);
    vi.mocked(getPayload).mockReturnValue("user message text");

    const interruptValue = JSON.stringify({
      threadTs: session.slackThreadTs,
      channelId: "C123",
      projectName: "test-project",
    });

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts" },
        user: { id: "U123" },
      },
      client,
      action: { action_id: "autopilot_interrupt_yes", value: interruptValue },
    });

    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "user message text",
        sessionId: session.sessionId,
        autopilot: false,
      })
    );
  });

  it("resumes with workspace in non-autopilot mode when no session but workspace exists", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);
    vi.mocked(getWorkspace).mockReturnValue({
      directory: "/home/user/workspace",
      projectName: "workspace-proj",
      channelId: "C456",
      autopilot: true,
    });
    vi.mocked(getPayload).mockReturnValue("user message text");

    const interruptValue = JSON.stringify({
      threadTs: "thread-ts",
      channelId: "C123",
      projectName: "test-project",
    });

    await getHandler()({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        message: { ts: "msg-ts" },
        user: { id: "U123" },
      },
      client,
      action: { action_id: "autopilot_interrupt_yes", value: interruptValue },
    });

    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C456",
        directory: "/home/user/workspace",
        projectName: "workspace-proj",
        prompt: "user message text",
        autopilot: false,
      })
    );
  });
});
