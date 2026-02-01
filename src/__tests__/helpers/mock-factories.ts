import { vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import type { ClaudeSession } from "../../claude/session-manager.js";
import type { Question } from "../../types/conversation.js";

export function createMockWebClient(): WebClient {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "mock-ts" }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    views: {
      open: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as unknown as WebClient;
}

export function createMockSession(overrides?: Partial<ClaudeSession>): ClaudeSession {
  return {
    sessionId: "test-session-id",
    projectName: "test-project",
    directory: "/home/user/test-project",
    slackChannelId: "C123456",
    slackThreadTs: "1706000000.000000",
    startedAt: new Date("2025-01-01T00:00:00Z"),
    lastActivityAt: new Date("2025-01-01T00:00:00Z"),
    autopilot: false,
    ...overrides,
  };
}

export function createMockQuestion(overrides?: Partial<Question>): Question {
  return {
    question: "Which database should we use?",
    header: "Database",
    options: [
      { label: "PostgreSQL", description: "Relational DB" },
      { label: "MongoDB", description: "Document DB" },
      { label: "Redis", description: "In-memory store" },
    ],
    multiSelect: false,
    ...overrides,
  };
}

export function createMockApp() {
  const handlers: Record<string, Function> = {};
  return {
    command: vi.fn((name: string, handler: Function) => {
      handlers[`command:${name}`] = handler;
    }),
    action: vi.fn((pattern: RegExp | string, handler: Function) => {
      handlers[`action:${String(pattern)}`] = handler;
    }),
    event: vi.fn((name: string, handler: Function) => {
      handlers[`event:${name}`] = handler;
    }),
    view: vi.fn((name: string, handler: Function) => {
      handlers[`view:${name}`] = handler;
    }),
    _handlers: handlers,
  };
}
