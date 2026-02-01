import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("fs", () => ({ existsSync: vi.fn() }));
vi.mock("../stores/channel-store.js", () => ({
  setChannelDir: vi.fn(),
}));
vi.mock("../core/config.js", () => ({
  config: {
    baseDir: "/home/user/Desktop",
  },
}));
vi.mock("../core/platform.js", () => ({
  expandTilde: vi.fn((p: string) => p.replace("~", "/home/user")),
}));
vi.mock("../i18n/index.js", () => ({ t: vi.fn((key: string) => key) }));
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerInitHandlers } from "../handlers/init-handlers.js";
import { existsSync } from "fs";
import { setChannelDir } from "../stores/channel-store.js";
import { createMockApp, createMockWebClient } from "./helpers/mock-factories.js";

describe("registerInitHandlers", () => {
  it("registers action and view handlers", () => {
    const app = createMockApp();
    registerInitHandlers(app as any);

    // 3 handlers: init_select_dir (regex), init_custom_input (string), init_custom_dir_modal (view)
    expect(app.action).toHaveBeenCalledTimes(2);
    expect(app.view).toHaveBeenCalledTimes(1);
    expect(app.view).toHaveBeenCalledWith("init_custom_dir_modal", expect.any(Function));
  });
});

describe("init_select_dir action", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerInitHandlers(app as any);
  });

  function getSelectDirHandler() {
    return app._handlers[`action:${/^init_select_dir_\d+$/}`];
  }

  it("sets channel directory and updates message on button click", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getSelectDirHandler();
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        user: { id: "U123" },
        message: { ts: "msg-ts" },
      },
      client,
      action: {
        action_id: "init_select_dir_0",
        value: JSON.stringify({ dirName: "my-project" }),
      },
    });

    expect(setChannelDir).toHaveBeenCalledWith("C123", {
      directory: "/home/user/Desktop/my-project",
      projectName: "my-project",
    });
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg-ts",
        text: "command.initSuccess",
      })
    );
  });

  it("sends ephemeral error when directory does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handler = getSelectDirHandler();
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        user: { id: "U123" },
        message: { ts: "msg-ts" },
      },
      client,
      action: {
        action_id: "init_select_dir_0",
        value: JSON.stringify({ dirName: "nonexistent" }),
      },
    });

    expect(setChannelDir).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        user: "U123",
        text: "command.initInvalidDir",
      })
    );
  });
});

describe("init_custom_input action", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerInitHandlers(app as any);
  });

  function getCustomInputHandler() {
    return app._handlers["action:init_custom_input"];
  }

  it("opens modal with correct callback_id", async () => {
    const handler = getCustomInputHandler();
    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: "C123" },
        user: { id: "U123" },
        message: { ts: "msg-ts" },
        trigger_id: "trigger-123",
      },
      client,
    });

    expect(client.views.open).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: "trigger-123",
        view: expect.objectContaining({
          callback_id: "init_custom_dir_modal",
        }),
      })
    );
  });
});

describe("init_custom_dir_modal view submission", () => {
  let app: ReturnType<typeof createMockApp>;
  let client: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    app = createMockApp();
    client = createMockWebClient();
    registerInitHandlers(app as any);
  });

  function getModalHandler() {
    return app._handlers["view:init_custom_dir_modal"];
  }

  it("sets channel directory for valid relative path", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getModalHandler();
    const ack = vi.fn();
    await handler({
      ack,
      view: {
        private_metadata: JSON.stringify({ channelId: "C123", originalMessageTs: "msg-ts" }),
        state: {
          values: {
            dir_block: {
              dir_input: { value: "my-project" },
            },
          },
        },
      },
      client,
      body: { user: { id: "U123" } },
    });

    expect(ack).toHaveBeenCalled();
    expect(setChannelDir).toHaveBeenCalledWith("C123", {
      directory: "/home/user/Desktop/my-project",
      projectName: "my-project",
    });
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg-ts",
      })
    );
  });

  it("sets channel directory for valid absolute path", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const handler = getModalHandler();
    const ack = vi.fn();
    await handler({
      ack,
      view: {
        private_metadata: JSON.stringify({ channelId: "C123", originalMessageTs: "msg-ts" }),
        state: {
          values: {
            dir_block: {
              dir_input: { value: "/opt/projects/my-app" },
            },
          },
        },
      },
      client,
      body: { user: { id: "U123" } },
    });

    expect(ack).toHaveBeenCalled();
    expect(setChannelDir).toHaveBeenCalledWith("C123", {
      directory: "/opt/projects/my-app",
      projectName: "my-app",
    });
  });

  it("returns error when directory does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handler = getModalHandler();
    const ack = vi.fn();
    await handler({
      ack,
      view: {
        private_metadata: JSON.stringify({ channelId: "C123", originalMessageTs: "msg-ts" }),
        state: {
          values: {
            dir_block: {
              dir_input: { value: "nonexistent" },
            },
          },
        },
      },
      client,
      body: { user: { id: "U123" } },
    });

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        response_action: "errors",
        errors: expect.objectContaining({
          dir_block: expect.any(String),
        }),
      })
    );
    expect(setChannelDir).not.toHaveBeenCalled();
  });
});
