import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../utils/slack-rate-limit.js", () => ({
  withRetry: vi.fn((fn: Function) => fn()),
}));
vi.mock("../slack/question-blocks.js", () => ({
  buildQuestionBlocks: vi.fn(() => [{ type: "section", text: { type: "mrkdwn", text: "mock" } }]),
}));
vi.mock("../stores/multi-select-state.js", () => ({
  getState: vi.fn(),
}));
vi.mock("../i18n/index.js", () => ({
  t: vi.fn((key: string) => key),
}));
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  postThreadMessage,
  postChannelMessage,
  updateSlackMessage,
  updateSlackMessageWithMultiSelect,
  addReaction,
  removeReaction,
  splitText,
  getUnclosedCodeFence,
  SLACK_MAX_TEXT_LENGTH,
} from "../utils/slack-message.js";
import { buildQuestionBlocks } from "../slack/question-blocks.js";
import { getState } from "../stores/multi-select-state.js";
import { t } from "../i18n/index.js";
import { createMockWebClient } from "./helpers/mock-factories.js";
import type { WebClient } from "@slack/web-api";

const mockedGetState = vi.mocked(getState);

describe("splitText", () => {
  it("returns single chunk for short text", () => {
    expect(splitText("hello", 100)).toEqual(["hello"]);
  });

  it("returns single chunk when text equals maxLength", () => {
    const text = "a".repeat(100);
    expect(splitText(text, 100)).toEqual([text]);
  });

  it("splits at paragraph boundary (\\n\\n)", () => {
    const part1 = "a".repeat(50);
    const part2 = "b".repeat(40);
    const text = `${part1}\n\n${part2}`;
    const chunks = splitText(text, 60);

    expect(chunks).toEqual([part1, part2]);
  });

  it("splits at line boundary (\\n) when no paragraph boundary", () => {
    const part1 = "a".repeat(50);
    const part2 = "b".repeat(40);
    const text = `${part1}\n${part2}`;
    const chunks = splitText(text, 60);

    expect(chunks).toEqual([part1, part2]);
  });

  it("force-splits when no natural boundary exists", () => {
    const text = "a".repeat(150);
    const chunks = splitText(text, 100);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(50);
  });

  it("handles multiple splits", () => {
    const text = "a".repeat(250);
    const chunks = splitText(text, 100);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });

  it("trims leading newlines from subsequent chunks", () => {
    const part1 = "a".repeat(50);
    const part2 = "b".repeat(30);
    const text = `${part1}\n\n\n\n${part2}`;
    const chunks = splitText(text, 55);

    expect(chunks[1]).toBe(part2);
    expect(chunks[1]).not.toMatch(/^\n/);
  });

  it("uses SLACK_MAX_TEXT_LENGTH as default maxLength", () => {
    const shortText = "hello";
    const chunks = splitText(shortText);
    expect(chunks).toEqual(["hello"]);
  });

  it("prefers paragraph boundary over line boundary", () => {
    // Structure: 40 chars + \n + 5 chars + \n\n + 5 chars + ... (long tail)
    const text = "a".repeat(40) + "\n" + "b".repeat(5) + "\n\n" + "c".repeat(5) + "\n" + "d".repeat(50);
    const chunks = splitText(text, 55);

    // Should split at \n\n (index 48) since it's within maxLength
    expect(chunks[0]).toBe("a".repeat(40) + "\n" + "b".repeat(5));
  });

  it("repairs code block split across chunks", () => {
    const text = "before\n```python\ncode line 1\ncode line 2\n```\nafter";
    // Split so that the code block is cut in the middle
    const chunks = splitText(text, 30);

    // Every chunk should have balanced code fences
    for (const chunk of chunks) {
      expect(getUnclosedCodeFence(chunk)).toBeNull();
    }
  });

  it("preserves language identifier when repairing code blocks", () => {
    const text = "```typescript\n" + "x".repeat(60) + "\n```\nafter";
    const chunks = splitText(text, 40);

    // First chunk should end with closing ```
    expect(chunks[0]).toMatch(/```$/);
    // Second chunk should reopen with the same language
    expect(chunks[1]).toMatch(/^```typescript\n/);
  });

  it("handles code block without language identifier", () => {
    const text = "```\n" + "x".repeat(60) + "\n```\nafter";
    const chunks = splitText(text, 40);

    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toMatch(/^```\n/);
  });

  it("does not modify chunks when code blocks are not split", () => {
    const text = "```python\nshort\n```\n\n" + "a".repeat(50);
    const chunks = splitText(text, 30);

    // First chunk has complete code block, no repair needed
    expect(chunks[0]).toBe("```python\nshort\n```");
  });

  it("handles multiple code blocks with only one split", () => {
    const text = "```\nblock1\n```\ntext\n```\n" + "x".repeat(60) + "\n```";
    const chunks = splitText(text, 40);

    for (const chunk of chunks) {
      expect(getUnclosedCodeFence(chunk)).toBeNull();
    }
  });

  it("handles split across three chunks inside a code block", () => {
    const text = "```python\n" + "x".repeat(100) + "\n```";
    const chunks = splitText(text, 40);

    for (const chunk of chunks) {
      expect(getUnclosedCodeFence(chunk)).toBeNull();
    }
    // First chunk opens and closes
    expect(chunks[0]).toMatch(/```$/);
    // Middle chunks reopen and close
    for (let i = 1; i < chunks.length - 1; i++) {
      expect(chunks[i]).toMatch(/^```python\n/);
      expect(chunks[i]).toMatch(/```$/);
    }
  });
});

describe("getUnclosedCodeFence", () => {
  it("returns null for text without code fences", () => {
    expect(getUnclosedCodeFence("hello world")).toBeNull();
  });

  it("returns null for balanced code fences", () => {
    expect(getUnclosedCodeFence("```python\ncode\n```")).toBeNull();
  });

  it("returns language for unclosed fence with language", () => {
    expect(getUnclosedCodeFence("```python\ncode")).toBe("python");
  });

  it("returns empty string for unclosed fence without language", () => {
    expect(getUnclosedCodeFence("```\ncode")).toBe("");
  });

  it("returns null for multiple balanced fences", () => {
    expect(getUnclosedCodeFence("```\na\n```\n```js\nb\n```")).toBeNull();
  });

  it("returns language for odd number of fences", () => {
    expect(getUnclosedCodeFence("```\na\n```\n```js\nb")).toBe("js");
  });

  it("returns full language tag with hyphens (e.g. shell-session)", () => {
    expect(getUnclosedCodeFence("```shell-session\n$ ls")).toBe("shell-session");
  });

  it("returns full language tag with special chars (e.g. c++)", () => {
    expect(getUnclosedCodeFence("```c++\nint main()")).toBe("c++");
  });
});

describe("postThreadMessage", () => {
  let client: WebClient;

  beforeEach(() => {
    client = createMockWebClient();
  });

  it("calls chat.postMessage with thread_ts", async () => {
    await postThreadMessage(client, "C123", "hello", "ts-parent");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "hello",
      thread_ts: "ts-parent",
    });
  });

  it("returns success with ts", async () => {
    const result = await postThreadMessage(client, "C123", "hello", "ts-parent");

    expect(result).toEqual({ success: true, ts: "mock-ts" });
  });

  it("returns { success: false, error } on error", async () => {
    const networkError = new Error("network error");
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(networkError);

    const result = await postThreadMessage(client, "C123", "hello", "ts-parent");

    expect(result).toEqual({ success: false, error: networkError });
  });

  it("splits long text into multiple messages", async () => {
    const longText = "a".repeat(39_000) + "\n\n" + "b".repeat(100);
    const postMessageMock = vi.mocked(client.chat.postMessage);
    postMessageMock
      .mockResolvedValueOnce({ ok: true, ts: "ts-1" } as any)
      .mockResolvedValueOnce({ ok: true, ts: "ts-2" } as any);

    const result = await postThreadMessage(client, "C123", longText, "ts-parent");

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    expect(postMessageMock).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      text: "a".repeat(39_000),
      thread_ts: "ts-parent",
    });
    expect(postMessageMock).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      text: "b".repeat(100),
      thread_ts: "ts-parent",
    });
    expect(result).toEqual({ success: true, ts: "ts-2" });
  });

  it("returns failure with error if any chunk fails", async () => {
    const longText = "a".repeat(39_000) + "\n\n" + "b".repeat(100);
    const rateLimitError = new Error("rate limit");
    vi.mocked(client.chat.postMessage)
      .mockResolvedValueOnce({ ok: true, ts: "ts-1" } as any)
      .mockRejectedValueOnce(rateLimitError);

    const result = await postThreadMessage(client, "C123", longText, "ts-parent");

    expect(result).toEqual({ success: false, error: rateLimitError });
  });

  it("skips sending when text is empty", async () => {
    const result = await postThreadMessage(client, "C123", "", "ts-parent");

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, ts: undefined });
  });
});

describe("postChannelMessage", () => {
  let client: WebClient;

  beforeEach(() => {
    client = createMockWebClient();
  });

  it("calls chat.postMessage without thread_ts", async () => {
    await postChannelMessage(client, "C123", "hello");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "hello",
    });
  });

  it("returns success with ts", async () => {
    const result = await postChannelMessage(client, "C123", "hello");

    expect(result).toEqual({ success: true, ts: "mock-ts" });
  });

  it("returns { success: false, error } on error", async () => {
    const networkError = new Error("network error");
    vi.mocked(client.chat.postMessage).mockRejectedValueOnce(networkError);

    const result = await postChannelMessage(client, "C123", "hello");

    expect(result).toEqual({ success: false, error: networkError });
  });
});

describe("updateSlackMessage", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    ts: "msg-ts",
    projectName: "test-project",
    messageId: "msg-1",
    question: { question: "Pick one", options: [{ label: "A" }] },
    isSubmitted: false,
  };

  beforeEach(() => {
    client = createMockWebClient();
  });

  it("calls buildQuestionBlocks with correct options", async () => {
    await updateSlackMessage({ client, ...baseOptions });

    expect(buildQuestionBlocks).toHaveBeenCalledWith({
      question: baseOptions.question,
      projectName: "test-project",
      messageId: "msg-1",
      selectedAnswer: undefined,
      isSubmitted: false,
    });
  });

  it("calls chat.update with blocks", async () => {
    await updateSlackMessage({ client, ...baseOptions });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg-ts",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "mock" } }],
      })
    );
  });

  it('uses "slack.answered" text when isSubmitted', async () => {
    await updateSlackMessage({
      client,
      ...baseOptions,
      isSubmitted: true,
      selectedAnswer: "Option A",
    });

    expect(t).toHaveBeenCalledWith("slack.answered");
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: "slack.answered" })
    );
  });

  it('uses "slack.question" text when not submitted', async () => {
    await updateSlackMessage({ client, ...baseOptions, isSubmitted: false });

    expect(t).toHaveBeenCalledWith("slack.question");
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: "slack.question" })
    );
  });

  it("does not throw on error (logs instead)", async () => {
    vi.mocked(client.chat.update).mockRejectedValueOnce(new Error("update failed"));

    await expect(
      updateSlackMessage({ client, ...baseOptions })
    ).resolves.toBeUndefined();
  });
});

describe("updateSlackMessageWithMultiSelect", () => {
  let client: WebClient;

  const baseOptions = {
    channelId: "C123",
    ts: "msg-ts",
    projectName: "test-project",
    messageId: "msg-1",
    selectedOptionIndexes: [0],
  };

  beforeEach(() => {
    client = createMockWebClient();
  });

  it("returns early when getState returns null", async () => {
    mockedGetState.mockReturnValueOnce(null);

    await updateSlackMessageWithMultiSelect({ client, ...baseOptions });

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("builds blocks with selectedOptionIndexes", async () => {
    mockedGetState.mockReturnValueOnce({
      selected: new Set([0]),
      options: [{ label: "A" }, { label: "B" }],
      questionText: "Pick many",
      header: "Multi Q",
    });

    await updateSlackMessageWithMultiSelect({ client, ...baseOptions });

    expect(buildQuestionBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedOptionIndexes: [0],
        isSubmitted: false,
      })
    );
  });

  it("calls chat.update", async () => {
    mockedGetState.mockReturnValueOnce({
      selected: new Set([0]),
      options: [{ label: "A" }, { label: "B" }],
      questionText: "Pick many",
      header: undefined,
    });

    await updateSlackMessageWithMultiSelect({ client, ...baseOptions });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "msg-ts",
        text: "slack.question",
      })
    );
  });
});

describe("addReaction", () => {
  let client: WebClient;

  beforeEach(() => {
    client = createMockWebClient();
  });

  it("calls reactions.add with correct params", async () => {
    await addReaction(client, "C123", "msg-ts", "thumbsup");

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "msg-ts",
      name: "thumbsup",
    });
  });

  it("silently ignores already_reacted error", async () => {
    const error = new Error("already_reacted") as any;
    error.data = { error: "already_reacted" };
    vi.mocked(client.reactions.add).mockRejectedValueOnce(error);

    await expect(addReaction(client, "C123", "msg-ts", "thumbsup")).resolves.toBeUndefined();
  });

  it("logs other errors", async () => {
    const error = new Error("some_other_error") as any;
    error.data = { error: "some_other_error" };
    vi.mocked(client.reactions.add).mockRejectedValueOnce(error);

    // Should not throw
    await expect(addReaction(client, "C123", "msg-ts", "thumbsup")).resolves.toBeUndefined();
  });
});

describe("removeReaction", () => {
  let client: WebClient;

  beforeEach(() => {
    client = createMockWebClient();
  });

  it("calls reactions.remove with correct params", async () => {
    await removeReaction(client, "C123", "msg-ts", "thumbsup");

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "msg-ts",
      name: "thumbsup",
    });
  });

  it("silently ignores no_reaction error", async () => {
    const error = new Error("no_reaction") as any;
    error.data = { error: "no_reaction" };
    vi.mocked(client.reactions.remove).mockRejectedValueOnce(error);

    await expect(removeReaction(client, "C123", "msg-ts", "thumbsup")).resolves.toBeUndefined();
  });

  it("logs other errors", async () => {
    const error = new Error("some_other_error") as any;
    error.data = { error: "some_other_error" };
    vi.mocked(client.reactions.remove).mockRejectedValueOnce(error);

    // Should not throw
    await expect(removeReaction(client, "C123", "msg-ts", "thumbsup")).resolves.toBeUndefined();
  });
});
