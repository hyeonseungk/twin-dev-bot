import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("fs", () => ({ existsSync: vi.fn(), readdirSync: vi.fn(), statSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("child_process", () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: Function) => cb(null, "", "")),
}));
vi.mock("../claude/session-manager.js", () => ({
  sessionManager: {
    getByThread: vi.fn(),
    add: vi.fn(),
    updateActivity: vi.fn(),
  },
}));
vi.mock("../utils/slack-message.js", () => ({
  postChannelMessage: vi.fn().mockResolvedValue({ success: true, ts: "thread-ts" }),
  postThreadMessage: vi.fn().mockResolvedValue({ success: true, ts: "msg-ts" }),
}));
vi.mock("../handlers/claude-runner-setup.js", () => ({
  setupClaudeRunner: vi.fn(),
}));
vi.mock("../templates.js", () => ({
  getTemplate: vi.fn(),
  getTemplateListText: vi.fn(() => "template list"),
}));
vi.mock("../i18n/index.js", () => ({ t: vi.fn((key: string) => key) }));
vi.mock("../stores/workspace-store.js", () => ({
  addWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
}));
vi.mock("../stores/channel-store.js", () => ({
  getChannelDir: vi.fn(),
  setChannelDir: vi.fn(),
}));
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../core/platform.js", () => ({
  getDefaultBaseDir: vi.fn(() => "/home/user/Desktop"),
}));
vi.mock("../core/config.js", () => ({
  config: {
    baseDir: "/home/user/Desktop",
    inactivityTimeoutMs: 30 * 60 * 1000,
  },
}));
vi.mock("../claude/active-runners.js", () => ({
  isRunnerActive: vi.fn(() => false),
  killActiveRunner: vi.fn(),
}));
vi.mock("../stores/action-payload-store.js", () => ({
  setPayload: vi.fn(),
  getPayload: vi.fn(),
  removePayload: vi.fn(),
}));

import { registerClaudeCommand } from "../handlers/claude-command.js";
import { existsSync, readdirSync, statSync } from "fs";
import { sessionManager } from "../claude/session-manager.js";
import { postChannelMessage, postThreadMessage } from "../utils/slack-message.js";
import { setupClaudeRunner } from "../handlers/claude-runner-setup.js";
import { addWorkspace, getWorkspace } from "../stores/workspace-store.js";
import { getChannelDir, setChannelDir } from "../stores/channel-store.js";
import { getTemplate } from "../templates.js";
import { createMockApp, createMockWebClient, createMockSession } from "./helpers/mock-factories.js";

describe("registerClaudeCommand", () => {
  it("registers command and event handlers", () => {
    const app = createMockApp();
    registerClaudeCommand(app as any);

    expect(app.command).toHaveBeenCalledWith("/twindevbot", expect.any(Function));
    expect(app.event).toHaveBeenCalledWith("message", expect.any(Function));
  });
});

describe("/twindevbot command", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerClaudeCommand(app as any);
  });

  function getCommandHandler() {
    return app._handlers["command:/twindevbot"];
  }

  it("shows usage when text is empty", async () => {
    const handler = getCommandHandler();
    const ack = vi.fn();

    await handler({ ack, body: { text: "", channel_id: "C123" }, client });

    expect(ack).toHaveBeenCalled();
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      expect.stringContaining("command.help")
    );
  });

  it("routes init subcommand", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(["project-a", "project-b"] as any);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "init", channel_id: "C123" },
      client,
    });

    // init posts message with blocks via client.chat.postMessage
    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it("routes task subcommand", async () => {
    vi.mocked(getChannelDir).mockReturnValue({
      directory: "/home/user/Desktop/my-project",
      projectName: "my-project",
    });
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "task", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.taskStarted"
    );
  });

  it("routes new subcommand", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new", channel_id: "C123" },
      client,
    });

    // new with no args shows usage
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      expect.stringContaining("command.newUsage")
    );
  });

  it("shows usage for unknown subcommand", async () => {
    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "unknown-cmd", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      expect.stringContaining("command.help")
    );
  });

  it("suggests closest command for typos", async () => {
    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "int", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.didYouMean"
    );
  });
});

describe("init", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerClaudeCommand(app as any);
  });

  function getCommandHandler() {
    return app._handlers["command:/twindevbot"];
  }

  it("shows directory buttons when baseDir has directories", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(["project-a", "project-b"] as any);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "init", channel_id: "C123" },
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "section" }),
          expect.objectContaining({ type: "actions" }),
        ]),
      })
    );
  });

  it("shows empty message when no directories", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([] as any);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "init", channel_id: "C123" },
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "section",
            text: expect.objectContaining({ text: "command.initEmpty" }),
          }),
        ]),
      })
    );
  });

  it("shows baseDirNotFound when baseDir does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "init", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.baseDirNotFound"
    );
  });
});

describe("task", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerClaudeCommand(app as any);
  });

  function getCommandHandler() {
    return app._handlers["command:/twindevbot"];
  }

  it("sends taskNoDir when no channel directory configured", async () => {
    vi.mocked(getChannelDir).mockReturnValue(undefined);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "task", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.taskNoDir"
    );
  });

  it("creates workspace when channel directory configured", async () => {
    vi.mocked(getChannelDir).mockReturnValue({
      directory: "/home/user/Desktop/my-project",
      projectName: "my-project",
    });
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "task", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.taskStarted"
    );
    expect(addWorkspace).toHaveBeenCalledWith(
      "thread-ts",
      expect.objectContaining({
        projectName: "my-project",
        channelId: "C123",
        autopilot: false,
      })
    );
  });

  it("passes --autopilot flag", async () => {
    vi.mocked(getChannelDir).mockReturnValue({
      directory: "/home/user/Desktop/my-project",
      projectName: "my-project",
    });
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "task --autopilot", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.taskStarted\ncommand.autopilotNotice"
    );
    expect(postThreadMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.taskSuccess\ncommand.autopilotNotice",
      "thread-ts"
    );
    expect(addWorkspace).toHaveBeenCalledWith(
      "thread-ts",
      expect.objectContaining({
        autopilot: true,
      })
    );
  });

  it("sends initInvalidDir when directory does not exist", async () => {
    vi.mocked(getChannelDir).mockReturnValue({
      directory: "/home/user/Desktop/deleted-project",
      projectName: "deleted-project",
    });
    vi.mocked(existsSync).mockReturnValue(false);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "task", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.initInvalidDir"
    );
  });
});

describe("new", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerClaudeCommand(app as any);

    // handleNew calls setChannelDir then handleTask which calls getChannelDir.
    // Link the mocks so setChannelDir updates what getChannelDir returns.
    vi.mocked(getChannelDir).mockReturnValue(undefined);
    vi.mocked(setChannelDir).mockImplementation((_channelId, dir) => {
      vi.mocked(getChannelDir).mockReturnValue(dir);
    });
  });

  function getCommandHandler() {
    return app._handlers["command:/twindevbot"];
  }

  it("sends usage when no args", async () => {
    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.newUsage"
    );
  });

  it("sends optionsRequired when no flag", async () => {
    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.newOptionsRequired"
    );
  });

  it("creates empty directory with --empty and sets channel dir", async () => {
    // BASE_DIR exists, project dir does not
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("Desktop")
    );

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project --empty", channel_id: "C123" },
      client,
    });

    // Should post emptyDirCreated message
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.emptyDirCreated"
    );
    // Should set channel directory
    expect(setChannelDir).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        projectName: "my-project",
      })
    );
  });

  it("sends dirAlreadyExists when exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project --empty", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.dirAlreadyExists"
    );
  });

  it("handles template with --template (shell command)", async () => {
    // BASE_DIR exists, project dir does not
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("Desktop")
    );
    vi.mocked(getTemplate).mockReturnValue({
      name: "React",
      category: "frontend",
      scaffold: vi.fn(() => "npm create vite my-project"),
    });

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project --template react", channel_id: "C123" },
      client,
    });

    expect(getTemplate).toHaveBeenCalledWith("react");
    // Should post creatingProject message
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.creatingProject"
    );
  });

  it("creates empty directory with --empty before dirName", async () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("Desktop")
    );

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new --empty my-project", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.emptyDirCreated"
    );
  });

  it("handles --template before dirName", async () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("Desktop")
    );
    vi.mocked(getTemplate).mockReturnValue({
      name: "React",
      category: "frontend",
      scaffold: vi.fn(() => "npm create vite my-project"),
    });

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new --template react my-project", channel_id: "C123" },
      client,
    });

    expect(getTemplate).toHaveBeenCalledWith("react");
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.creatingProject"
    );
  });

  it("sends usage when only flags without dirName", async () => {
    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new --empty", channel_id: "C123" },
      client,
    });

    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.newUsage"
    );
  });

  it("passes --autopilot flag through to handleTask after --empty new", async () => {
    // handleNew: baseDir exists (true), project dir does not (false)
    // handleTask: directory exists (true)
    let callCount = 0;
    vi.mocked(existsSync).mockImplementation((p) => {
      callCount++;
      const path = String(p);
      if (path.endsWith("Desktop")) return true;
      // First check in handleNew (project dir) => false
      // Second check in handleTask (project dir) => true
      return callCount > 2;
    });

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project --empty --autopilot", channel_id: "C123" },
      client,
    });

    // Should create the empty directory and set channel dir
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.emptyDirCreated"
    );
    expect(setChannelDir).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        projectName: "my-project",
      })
    );
    // handleTask should have been called with --autopilot, resulting in autopilot workspace
    expect(addWorkspace).toHaveBeenCalledWith(
      "thread-ts",
      expect.objectContaining({
        projectName: "my-project",
        autopilot: true,
      })
    );
  });

  it("passes --autopilot flag through to handleTask after --template new (async scaffold)", async () => {
    // Use async scaffold function (Node.js API mode) to avoid child_process.exec mock issues
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("Desktop")
    );
    const asyncScaffold = vi.fn(async (_cwd: string) => {});
    vi.mocked(getTemplate).mockReturnValue({
      name: "React",
      category: "frontend",
      scaffold: vi.fn(() => asyncScaffold),
    });

    // After scaffold completes, handleTask checks existsSync for the project dir.
    // Override existsSync to return true for everything after scaffold runs.
    asyncScaffold.mockImplementation(async () => {
      vi.mocked(existsSync).mockReturnValue(true as any);
    });

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project --template react --autopilot", channel_id: "C123" },
      client,
    });

    // handleTask should have been called with --autopilot
    expect(setChannelDir).toHaveBeenCalled();
    expect(addWorkspace).toHaveBeenCalledWith(
      "thread-ts",
      expect.objectContaining({
        projectName: "my-project",
        autopilot: true,
      })
    );
  });

  it("handles template with async scaffold function", async () => {
    // BASE_DIR exists, project dir does not
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("Desktop")
    );
    const asyncScaffold = vi.fn(async (_cwd: string) => {});
    vi.mocked(getTemplate).mockReturnValue({
      name: "FastAPI",
      category: "backend",
      scaffold: vi.fn(() => asyncScaffold),
    });

    const handler = getCommandHandler();
    await handler({
      ack: vi.fn(),
      body: { text: "new my-project --template fastapi", channel_id: "C123" },
      client,
    });

    expect(getTemplate).toHaveBeenCalledWith("fastapi");
    expect(asyncScaffold).toHaveBeenCalled();
    expect(postChannelMessage).toHaveBeenCalledWith(
      client,
      "C123",
      "command.creatingProject"
    );
  });
});

describe("message event", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerClaudeCommand(app as any);
  });

  function getEventHandler() {
    return app._handlers["event:message"];
  }

  it("ignores bot messages", async () => {
    const handler = getEventHandler();
    await handler({
      event: { text: "hello", channel: "C123", thread_ts: "ts123", ts: "msg-ts", bot_id: "B123" },
      client,
    });

    expect(sessionManager.getByThread).not.toHaveBeenCalled();
  });

  it("ignores messages without text", async () => {
    const handler = getEventHandler();
    await handler({
      event: { channel: "C123", thread_ts: "ts123", ts: "msg-ts" },
      client,
    });

    expect(sessionManager.getByThread).not.toHaveBeenCalled();
  });

  it("ignores non-thread messages", async () => {
    const handler = getEventHandler();
    await handler({
      event: { text: "hello", channel: "C123", ts: "msg-ts" },
      client,
    });

    expect(sessionManager.getByThread).not.toHaveBeenCalled();
  });

  it("resumes session when found", async () => {
    const session = createMockSession();
    vi.mocked(sessionManager.getByThread).mockReturnValue(session);

    const handler = getEventHandler();
    await handler({
      event: { text: "hello", channel: "C123", thread_ts: "ts123", ts: "msg-ts" },
      client,
    });

    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        channelId: session.slackChannelId,
        threadTs: session.slackThreadTs,
        directory: session.directory,
        projectName: session.projectName,
        prompt: "hello",
        sessionId: session.sessionId,
      })
    );
  });

  it("starts from workspace when no session", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);
    vi.mocked(getWorkspace).mockReturnValue({
      directory: "/home/user/workspace",
      projectName: "workspace-proj",
      channelId: "C456",
      autopilot: false,
    });

    const handler = getEventHandler();
    await handler({
      event: { text: "start work", channel: "C123", thread_ts: "ts456", ts: "msg-ts" },
      client,
    });

    expect(setupClaudeRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        channelId: "C456",
        threadTs: "ts456",
        directory: "/home/user/workspace",
        projectName: "workspace-proj",
        prompt: "start work",
      })
    );
  });

  it("does nothing when neither found", async () => {
    vi.mocked(sessionManager.getByThread).mockReturnValue(undefined);
    vi.mocked(getWorkspace).mockReturnValue(undefined);

    const handler = getEventHandler();
    await handler({
      event: { text: "hello", channel: "C123", thread_ts: "ts123", ts: "msg-ts" },
      client,
    });

    expect(setupClaudeRunner).not.toHaveBeenCalled();
  });
});
