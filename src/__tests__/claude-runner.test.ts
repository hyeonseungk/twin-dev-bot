import { EventEmitter } from "events";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Store spawn mock for later access
let mockSpawnImpl: (...args: any[]) => any;

vi.mock("child_process", () => ({
  spawn: vi.fn((...args: any[]) => mockSpawnImpl(...args)),
  execSync: vi.fn(),
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { spawn, execSync } from "child_process";
import { ClaudeRunner, runClaude } from "../claude/claude-runner.js";
import type { InitEvent, TextEvent, ToolUseEvent, AskUserEvent, ResultEvent } from "../claude/claude-runner.js";

const mockSpawn = vi.mocked(spawn);
const mockExecSync = vi.mocked(execSync);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return proc;
}

function feedLine(proc: ReturnType<typeof createMockProcess>, json: object) {
  proc.stdout.emit("data", Buffer.from(JSON.stringify(json) + "\n"));
}

function makeInitEvent(overrides?: Partial<Record<string, unknown>>) {
  return {
    type: "system",
    subtype: "init",
    session_id: "sess-abc",
    model: "claude-3",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "env",
    claude_code_version: "2.1.25",
    output_style: "stream-json",
    agents: [],
    skills: [],
    plugins: [],
    uuid: "uuid-1",
    ...overrides,
  };
}

function makeAssistantTextEvent(text: string) {
  return {
    type: "assistant",
    message: {
      model: "claude-3",
      id: "msg-1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: "sess-abc",
    uuid: "uuid-2",
  };
}

function makeAssistantToolUseEvent(
  name: string,
  input: Record<string, unknown> = {},
  id?: string
) {
  return {
    type: "assistant",
    message: {
      model: "claude-3",
      id: "msg-2",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: "sess-abc",
    uuid: "uuid-3",
  };
}

function makeAskUserEvent() {
  return makeAssistantToolUseEvent(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Which DB?",
          header: "Database",
          options: [{ label: "PostgreSQL" }, { label: "MongoDB" }],
        },
      ],
    },
    "tu-ask-1"
  );
}

function makeResultEvent(overrides?: Partial<Record<string, unknown>>) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5000,
    duration_api_ms: 4000,
    num_turns: 3,
    result: "done",
    session_id: "sess-abc",
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 200 },
    modelUsage: {},
    permission_denials: [],
    uuid: "uuid-result",
    ...overrides,
  };
}

describe("ClaudeRunner", () => {
  let proc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    proc = createMockProcess();
    mockSpawnImpl = () => proc;
  });

  describe("run()", () => {
    it("spawns claude with correct base args", () => {
      const runner = new ClaudeRunner({
        directory: "/home/user/proj",
        prompt: "hello",
      });
      runner.run();

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "-p", "hello",
          "--output-format", "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
        ]),
        expect.objectContaining({
          cwd: "/home/user/proj",
        })
      );
    });

    it("includes --resume when sessionId provided", () => {
      const runner = new ClaudeRunner({
        directory: "/tmp",
        prompt: "continue",
        sessionId: "resume-id",
      });
      runner.run();

      const callArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(callArgs[0]).toBe("--resume");
      expect(callArgs[1]).toBe("resume-id");
    });

    it("sets cwd to directory", () => {
      const runner = new ClaudeRunner({
        directory: "/my/project",
        prompt: "do stuff",
      });
      runner.run();

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({ cwd: "/my/project" })
      );
    });
  });

  describe("init event", () => {
    it("emits init with sessionId and model", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const initHandler = vi.fn();
      runner.on("init", initHandler);

      feedLine(proc, makeInitEvent());

      expect(initHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-abc",
          model: "claude-3",
        })
      );
    });

    it("updates currentSessionId", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      runner.on("init", () => {}); // subscribe to avoid unhandled events
      feedLine(proc, makeInitEvent({ session_id: "new-session-id" }));

      expect(runner.currentSessionId).toBe("new-session-id");
    });

    it("deduplicates init events", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const initHandler = vi.fn();
      runner.on("init", initHandler);

      feedLine(proc, makeInitEvent());
      feedLine(proc, makeInitEvent());

      expect(initHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("text event", () => {
    it("emits text for assistant text blocks", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const textHandler = vi.fn();
      runner.on("text", textHandler);

      feedLine(proc, makeAssistantTextEvent("hello world"));

      expect(textHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: "hello world" })
      );
    });

    it("emits consecutive identical text blocks without dedup", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const textHandler = vi.fn();
      runner.on("text", textHandler);

      feedLine(proc, makeAssistantTextEvent("same text"));
      feedLine(proc, makeAssistantTextEvent("same text"));

      expect(textHandler).toHaveBeenCalledTimes(2);
    });

    it("emits different text after previous", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const textHandler = vi.fn();
      runner.on("text", textHandler);

      feedLine(proc, makeAssistantTextEvent("first"));
      feedLine(proc, makeAssistantTextEvent("second"));

      expect(textHandler).toHaveBeenCalledTimes(2);
      expect(textHandler).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "first" }));
      expect(textHandler).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "second" }));
    });
  });

  describe("toolUse event", () => {
    it("emits toolUse for tool_use blocks", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const toolHandler = vi.fn();
      runner.on("toolUse", toolHandler);

      feedLine(proc, makeAssistantToolUseEvent("Read", { file_path: "/tmp/a.txt" }, "tu1"));

      expect(toolHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "Read",
          input: { file_path: "/tmp/a.txt" },
        })
      );
    });

    it("deduplicates by tool_use id", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const toolHandler = vi.fn();
      runner.on("toolUse", toolHandler);

      feedLine(proc, makeAssistantToolUseEvent("Read", {}, "tu-dup"));
      feedLine(proc, makeAssistantToolUseEvent("Read", {}, "tu-dup"));

      expect(toolHandler).toHaveBeenCalledTimes(1);
    });

    it("emits if no id (no dedup)", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const toolHandler = vi.fn();
      runner.on("toolUse", toolHandler);

      feedLine(proc, makeAssistantToolUseEvent("Read", {}, undefined));
      feedLine(proc, makeAssistantToolUseEvent("Read", {}, undefined));

      expect(toolHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe("askUser event", () => {
    it("emits askUser for AskUserQuestion tool", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const askHandler = vi.fn();
      runner.on("askUser", askHandler);

      feedLine(proc, makeAskUserEvent());

      expect(askHandler).toHaveBeenCalledTimes(1);
    });

    it("includes input with questions", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const askHandler = vi.fn();
      runner.on("askUser", askHandler);

      feedLine(proc, makeAskUserEvent());

      const event: AskUserEvent = askHandler.mock.calls[0][0];
      expect(event.input.questions).toBeDefined();
      expect(event.input.questions[0].question).toBe("Which DB?");
      expect(event.input.questions[0].options).toHaveLength(2);
    });
  });

  describe("exitPlanMode event", () => {
    it("emits exitPlanMode for ExitPlanMode tool", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const handler = vi.fn();
      runner.on("exitPlanMode", handler);

      feedLine(proc, makeAssistantToolUseEvent("ExitPlanMode", {}, "tu-epm-1"));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("result event", () => {
    it("emits result with costUsd", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const resultHandler = vi.fn();
      runner.on("result", resultHandler);

      feedLine(proc, makeResultEvent());

      expect(resultHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          result: "done",
          costUsd: 0.01,
        })
      );
    });

    it("deduplicates result events", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const resultHandler = vi.fn();
      runner.on("result", resultHandler);

      feedLine(proc, makeResultEvent());
      feedLine(proc, makeResultEvent());

      expect(resultHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("error and exit", () => {
    it("emits error on process error", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const errorHandler = vi.fn();
      runner.on("error", errorHandler);

      const err = new Error("spawn failed");
      proc.emit("error", err);

      expect(errorHandler).toHaveBeenCalledWith(err);
    });

    it("emits exit with code", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const exitHandler = vi.fn();
      runner.on("exit", exitHandler);

      proc.emit("exit", 0);

      expect(exitHandler).toHaveBeenCalledWith(0);
    });

    it("processes remaining buffer on exit", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const resultHandler = vi.fn();
      runner.on("result", resultHandler);

      // Send data WITHOUT trailing newline (stays in buffer)
      const resultJson = JSON.stringify(makeResultEvent());
      proc.stdout.emit("data", Buffer.from(resultJson));
      // Not yet emitted because no newline
      expect(resultHandler).not.toHaveBeenCalled();

      // On exit, the remaining buffer should be processed
      proc.emit("exit", 0);
      expect(resultHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleLine", () => {
    it("ignores non-JSON lines", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      const textHandler = vi.fn();
      const initHandler = vi.fn();
      runner.on("text", textHandler);
      runner.on("init", initHandler);

      // Feed non-JSON line
      proc.stdout.emit("data", Buffer.from("Loading Claude...\n"));

      expect(textHandler).not.toHaveBeenCalled();
      expect(initHandler).not.toHaveBeenCalled();
    });
  });

  describe("kill()", () => {
    it("kills the process on non-Windows", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();

      runner.kill();

      expect(proc.kill).toHaveBeenCalled();
    });

    it("uses taskkill on Windows", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      const winProc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
        pid: 12345,
      });
      mockSpawnImpl = () => winProc;

      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      runner.run();
      runner.kill();

      expect(mockExecSync).toHaveBeenCalledWith(
        "taskkill /pid 12345 /T /F",
        { stdio: "ignore" }
      );

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("handles null process", () => {
      const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
      // Don't call run(), so process is null

      // Should not throw
      expect(() => runner.kill()).not.toThrow();
    });
  });
});

describe("stderrOutput", () => {
  it("returns empty string when no stderr", () => {
    const proc = createMockProcess();
    mockSpawnImpl = () => proc;

    const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
    runner.run();

    expect(runner.stderrOutput).toBe("");
  });

  it("collects stderr output", () => {
    const proc = createMockProcess();
    mockSpawnImpl = () => proc;

    const runner = new ClaudeRunner({ directory: "/tmp", prompt: "hi" });
    runner.run();

    proc.stderr.emit("data", Buffer.from("Error: API key expired\n"));
    proc.stderr.emit("data", Buffer.from("Connection refused\n"));

    expect(runner.stderrOutput).toBe("Error: API key expired\nConnection refused");
  });
});

describe("runClaude()", () => {
  it("creates runner and calls run()", () => {
    const proc = createMockProcess();
    mockSpawnImpl = () => proc;

    const runner = runClaude({
      directory: "/tmp/proj",
      prompt: "build it",
    });

    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect(mockSpawn).toHaveBeenCalled();
  });
});
