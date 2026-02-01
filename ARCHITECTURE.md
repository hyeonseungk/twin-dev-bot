# Architecture

Internal architecture documentation for Twin Dev Bot.

---

## System Overview

```
                        Slack (Socket Mode / WebSocket)
                                    |
                                    v
+----------------------------------------------------------------------+
|                          server.ts                                    |
|                     Slack Bolt App (Socket Mode)                      |
|                                                                       |
|  +----------------------------+  +---------------------------------+ |
|  |  claude-command.ts          |  |  question-handlers.ts           | |
|  |  - /twindevbot slash cmd    |  |  - Button clicks (single/multi) | |
|  |  - Thread message handling  |  |  - Modal text input             | |
|  |  - Interrupt confirmation   |  |  - Interrupt handling           | |
|  +----------+-----------------+  +----------+----------------------+ |
|             |                               |                        |
|  +----------+-------------------------------+----------------------+ |
|  |  init-handlers.ts                                               | |
|  |  - /twindevbot init directory selection buttons/modal           | |
|  +-----------------------------------------------------------------+ |
+-------------+-------------------------------+------------------------+
              |                               |
              v                               v
+----------------------------------------------------------------------+
|                    claude-runner-setup.ts                              |
|                                                                       |
|  Spawns Claude CLI and binds event handlers                           |
|  - init -> register session                                           |
|  - text -> buffer via TextBuffer, then send to Slack thread           |
|  - toolUse -> update progress status                                  |
|  - askUser -> send question UI to Slack or auto-answer in autopilot   |
|  - exitPlanMode -> auto-approve and resume                            |
|  - result -> handle completion                                        |
+-------------------------+--------------------------------------------+
                          |
                          v
+----------------------------------------------------------------------+
|                      claude-runner.ts                                  |
|                                                                       |
|  spawn("claude", ["-p", prompt, "--output-format", "stream-json",    |
|                    "--verbose", "--dangerously-skip-permissions"])     |
|                                                                       |
|  Parse stdout JSONL -> emit events via EventEmitter                   |
+----------------------------------------------------------------------+
                          |
                          v
                     Claude CLI
```

---

## Core Concepts

### Channel Setup -> Task Start Flow

1. `/twindevbot init` -> show directory selection UI in channel -> user selects -> save channel-directory mapping in `channel-store`
2. `/twindevbot task` -> create parent message in channel using registered directory -> save thread-directory mapping in `workspace-store`
3. Thread message -> look up Session or Workspace -> start/resume Claude session

### Thread = Session

One Slack thread maps to one Claude session.

1. Running `/twindevbot task` creates a parent message in the channel
2. When a user sends a message in that thread, a Claude session starts
3. All subsequent interactions in the same thread continue the same session via `--resume`

### Channel, Workspace, Session Hierarchy

- **Channel**: Channel-to-directory mapping set via `/twindevbot init`. Persisted in `data/channels.json`.
- **Workspace**: Mapping created when `/twindevbot task` runs (thread ts -> directory info). Persisted in `data/workspaces.json`.
- **Session**: Persistent data created after the first Claude execution (thread ts -> Claude sessionId). Persisted in `data/sessions.json`.

On message receipt, Session is looked up first; if not found, Workspace is looked up. Once a Session is created, the corresponding Workspace is deleted (prevents memory leaks).

### Active Runner Registry

`active-runners.ts` tracks running ClaudeRunner instances per thread.

- **Concurrent execution prevention**: Blocks multiple Claude processes from running simultaneously on the same thread
- **Inactivity timeout**: Automatically terminates the process if no events are received for `INACTIVITY_TIMEOUT_MINUTES` (default 30 min) after the last event
- **Interrupt support**: Allows users to stop a running task

### AskUserQuestion Flow

When Claude calls the `AskUserQuestion` tool:

1. `claude-runner.ts` emits an `askUser` event
2. `claude-runner-setup.ts` sends a question UI (buttons) to Slack
3. The Claude process is `kill()`ed (stdin is `"ignore"`, so it cannot receive direct responses)
4. The user responds on Slack (button click or modal input)
5. `question-handlers.ts` calls `setupClaudeRunner()` to resume the session via `--resume`

```
Claude running -> AskUserQuestion detected -> send Slack UI -> kill()
                                                                 |
User Slack response <- - - - - - - - - - - - - - - - - - - - - -+
        |
        v
setupClaudeRunner(sessionId, answer) -> claude --resume <sessionId> -p "answer"
```

**Multi-question batching**: When Claude sends multiple questions at once, `pending-questions.ts` displays them one at a time on Slack, collects all answers, then combines them and sends to Claude.

### ExitPlanMode Handling

When Claude calls the `ExitPlanMode` tool:

1. stdin is "ignore", so the CLI cannot receive user approval
2. The process is killed and resumed with a "Plan approved" message to exit plan mode

### Autopilot Mode

Activated with `/twindevbot task --autopilot`.

When AskUserQuestion fires, options are auto-selected without waiting for user input:
- Options whose label contains "recommended" (case-insensitive) are preferred
- If none, the first option is selected
- For multiSelect, all "recommended" options are selected (otherwise the first option)

All questions and auto-selected answers are logged in the Slack thread for review.

Flow:

1. `askUser` event received
2. Extract recommended/first option label
3. Post question UI to Slack in completed state (`isSubmitted: true`)
4. `runner.kill()` then immediately call `setupClaudeRunner()` (autopilot flag preserved)

### Interrupts (Mid-execution Intervention)

When a user sends a message in a thread where Claude is already running, an interrupt confirmation UI is shown.

**Autopilot mode interrupt:**
- "Yes" -> disable autopilot -> kill existing runner -> run user message in normal mode
- "No" -> continue autopilot

**Normal mode interrupt:**
- "Yes" -> kill existing runner -> start new task with user message
- "No" -> continue existing task

User messages are stored server-side in `action-payload-store` to handle Slack's action.value size limit (~2KB).

---

## File Structure and Roles

```
src/
├── server.ts                      # Slack Bolt App initialization and startup
├── cli.ts                         # CLI (start, stop, status, show, clear, help)
├── setup.ts                       # Interactive CLI setup wizard (.env creation)
├── templates.ts                   # Project scaffolding templates
├── core/                          # Core infrastructure
│   ├── config.ts                  # Environment variable loading and validation (lazy init)
│   ├── logger.ts                  # Level-based structured logger
│   ├── paths.ts                   # Path configuration (based on cwd)
│   └── platform.ts                # Cross-platform utilities (OS detection, tilde expansion)
├── claude/                        # Claude execution layer
│   ├── claude-runner.ts           # Claude CLI process execution and stream-json parsing
│   ├── session-manager.ts         # Claude session CRUD and file persistence
│   └── active-runners.ts          # Per-thread running Claude process registry
├── stores/                        # State management (file-based + in-memory)
│   ├── workspace-store.ts         # /twindevbot task workspace mapping
│   ├── channel-store.ts           # /twindevbot init channel-directory mapping
│   ├── multi-select-state.ts      # Multi-select UI state management
│   ├── pending-questions.ts       # Multi-question batch management
│   └── action-payload-store.ts    # Server-side Slack action payload storage
├── slack/                         # Slack UI components
│   ├── progress-tracker.ts        # Progress display via Slack reactions/messages
│   └── question-blocks.ts         # AskUserQuestion -> Slack Block Kit conversion
├── handlers/                      # Slack event handlers
│   ├── index.ts                   # Handler barrel export
│   ├── claude-command.ts          # /twindevbot slash command and message events
│   ├── claude-runner-setup.ts     # Claude runner spawning and event handler binding
│   ├── question-handlers.ts       # Button clicks, modal submissions, interrupt handling
│   └── init-handlers.ts           # Directory selection button/modal handling
├── daemon/                        # Platform-specific daemon management
│   ├── index.ts                   # Platform factory (createDaemonManager)
│   ├── macos.ts                   # macOS launchd daemon
│   ├── windows.ts                 # Windows Task Scheduler daemon
│   └── types.ts                   # DaemonManager interface
├── i18n/                          # Internationalization
│   ├── index.ts                   # t() function, initLocale
│   └── en.ts                      # English translations
├── utils/                         # Utilities
│   ├── slack-message.ts           # Slack API wrapper (message/reaction/update)
│   ├── slack-rate-limit.ts        # Slack API auto-retry wrapper
│   ├── safe-async.ts              # Async error catch wrapper for EventEmitter
│   └── display-width.ts           # CJK/emoji string width calculation
├── types/                         # TypeScript type definitions
│   ├── index.ts                   # Type barrel export
│   ├── slack.ts                   # Button value, modal metadata, interrupt types
│   ├── conversation.ts            # Question, QuestionOption types
│   └── claude-stream.ts           # Claude CLI stream-json output types
└── __tests__/                     # Tests
    ├── helpers/
    │   └── mock-factories.ts      # Common mock factories
    └── *.test.ts                  # Per-module test files
```

---

## Key Component Details

### claude-runner.ts

Spawns the Claude CLI as a child process and parses its JSONL (line-delimited JSON) stdout output.

```typescript
// Spawn command
spawn("claude", [
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
  // If sessionId is present:
  "--resume",
  sessionId,
]);
```

- stdin: `"ignore"` (no user input possible)
- stdout: JSONL parsing -> EventEmitter events
- stderr: Buffered for error diagnostics
- Deduplication: Tracks processed tool_use IDs via `Set`, plus init/result duplicate flags

Emitted events:

| Event          | Trigger                | Key Data                    |
| -------------- | ---------------------- | --------------------------- |
| `init`         | Session started        | `sessionId`, `model`        |
| `text`         | Text output            | `text`                      |
| `toolUse`      | Tool usage             | `toolName`, `input`         |
| `askUser`      | AskUserQuestion called | `input.questions[]`         |
| `exitPlanMode` | ExitPlanMode called    | `{}`                        |
| `result`       | Task completed         | `result`, `costUsd`         |
| `error`        | Process error          | `Error` object              |
| `exit`         | Process exit           | exit code                   |

### claude-runner-setup.ts

Central module that creates the Claude process and binds event handlers.

**TextBuffer**: Accumulates text messages in a buffer for 2 seconds, then sends them to Slack in a single batch to prevent rate limiting.

**Race condition prevention state**:
- `resultReceived` / `resultPromise`: Ensures ordering between result and exit events
- `completionHandled`: Prevents duplicate completion handling
- `handlerTakeover` / `processExitedEarly`: Handles unexpected process termination during askUser/exitPlanMode async operations

### session-manager.ts

Manages Claude session information, automatically persisted to `data/sessions.json`.

```typescript
interface ClaudeSession {
  sessionId: string;       // Session ID issued by Claude CLI
  projectName: string;
  directory: string;
  slackChannelId: string;
  slackThreadTs: string;   // Thread parent message ts (= session identifier)
  startedAt: Date;
  lastActivityAt: Date;
  autopilot: boolean;
}
```

Maintains 3 indexes:

- `sessionId -> ClaudeSession`
- `projectName:threadTs -> sessionId`
- `threadTs -> sessionId`

Automatically restored from file on server restart. Sessions inactive for 24 hours are automatically cleaned up every hour.

### active-runners.ts

Registry that tracks running Claude processes per thread.

```typescript
interface RunnerEntry {
  runner: ClaudeRunner;
  timer: NodeJS.Timeout;      // Inactivity timeout timer
  registeredAt: number;
  lastActivityAt: number;
  onTimeout?: () => void;     // Timeout callback (Slack notification, etc.)
}
```

Key functions:

- `registerRunner(threadTs, runner, options)`: Register a runner (auto-kills existing runner)
- `refreshActivity(threadTs, runner)`: Refresh activity time and reset timer
- `unregisterRunner(threadTs, runner)`: Unregister runner (instance identity verification)
- `isRunnerActive(threadTs)`: Check if an active runner exists
- `killActiveRunner(threadTs)`: Force-kill by external request (interrupt, stop)
- `killAllRunners()`: Kill all runners during graceful shutdown

### progress-tracker.ts

Displays progress status via emoji reactions on user messages and posts status messages in the thread.

```
Reaction transitions:
  eyes (received) -> gear (working) -> white_check_mark (completed) / x (error) / raised_hand (askUser) / thumbsup (planApproved)

Status message update (no reaction change, message text only):
  While in gear (working) state -> robot_face autopilotContinue (auto-responded, continuing)
```

The status message is posted once in the thread and then updated via `chat.update()`. During tool usage, the tool name (i18n translated) is displayed with 5-second throttling. On completion, elapsed time is shown.

### question-blocks.ts

Converts Claude's `AskUserQuestion` into Slack Block Kit UI.

**Single-select mode:**

- Each option is an independent button (75-char limit, truncated if exceeded)
- "Custom Input" button (opens modal)
- Selection is immediate on click

**Multi-select mode (`multiSelect: true`):**

- Each option is a toggle button (click toggles checkmark)
- "Submit Selection" button (final submission)
- "Custom Input" button
- Current selection status hint at the bottom

**Completed state (`isSubmitted: true`):**

- Selected answer is displayed; action buttons are not rendered

Respects Slack's 50-block limit per message.

### stores

#### workspace-store.ts

Thread-to-directory mapping created when `/twindevbot task` runs.

```typescript
interface Workspace {
  directory: string;
  projectName: string;
  channelId: string;
  autopilot?: boolean;
  createdAt?: Date;
}
```

Persisted to `data/workspaces.json`. Workspaces inactive for 24 hours are automatically deleted.

#### channel-store.ts

Channel-to-directory mapping set via `/twindevbot init`.

```typescript
interface ChannelDir {
  directory: string;
  projectName: string;
}
```

Persisted to `data/channels.json`.

#### multi-select-state.ts

Tracks user toggle state for multi-select questions.

```typescript
interface MultiSelectState {
  selected: Set<number>;
  options: QuestionOption[];
  questionText: string;
  header?: string;
}
// Key: "projectName:messageId"
```

In-memory only, 1-hour TTL with automatic cleanup.

#### pending-questions.ts

Manages sequential processing when Claude sends multiple questions at once.

```typescript
interface PendingQuestionBatch {
  questions: Question[];
  answers: string[];
  currentIndex: number;
  projectName: string;
  channelId: string;
  createdAt: number;
}
// Key: threadTs
```

Flow: Show question 1 -> user answers -> show question 2 -> ... -> combine all answers in `[header]: answer` format -> resume Claude.

In-memory only, 1-hour TTL with automatic cleanup.

#### action-payload-store.ts

Server-side store to handle Slack's `action.value` (~2KB) and `private_metadata` (~3KB) size limits.

Stores large payloads on the server; button values only contain short keys (messageId).

- Question data: `q:${messageId}` -> `StoredQuestionPayload`
- Interrupt messages: `interrupt:${threadTs}:${userMessageTs}` -> user message text

TTL-based automatic cleanup (default 2 hours). TTL is refreshed on access.

### templates.ts

Project scaffolding templates used by `/twindevbot new <dir> --template <key>`.

```typescript
interface FrameworkTemplate {
  name: string;
  category: "frontend" | "backend";
  scaffold: (projectName: string) => string | ((cwd: string) => Promise<void>);
  timeout?: number;
}
```

Templates by category:

- **Frontend**: react, nextjs, vue, nuxt, sveltekit, angular, react-native-expo, react-native-bare, flutter
- **Backend**: express, nestjs, fastify, spring-boot, django, fastapi, go, rails, laravel

Each template returns either a shell command string or a Node.js API function. Timeout is configurable per template (default 5 minutes).

### daemon

Platform-specific background service management.

```typescript
interface DaemonManager {
  start(): void;
  stop(): void;
  status(): void;
  isRunning(): boolean;
  getLogViewCommand(logPath: string): string;
}
```

- **macOS** (`macos.ts`): Uses launchd. Creates `~/Library/LaunchAgents/com.twin-dev-bot.plist`.
- **Windows** (`windows.ts`): Task Scheduler-based background service.
- **Factory** (`index.ts`): `createDaemonManager()` returns the appropriate manager for the platform (daemon commands are supported on macOS/Windows only).

### i18n

Translates via `t(key, params?)`. Supports `{{param}}`-style template variables.

```typescript
t("progress.completed", { elapsed: "15s" });
// "Completed (15s)"
```

Currently only English (`en`) is supported. The i18n framework (`initLocale`, `t`, `getCurrentLocale`) is kept in place so adding a new locale only requires creating a translation file. Fallback: current locale -> `en` -> raw key string.

---

## CLI

The `twindevbot` command manages the server.

| Command                     | Description                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `twindevbot start`          | Start server in foreground (runs setup wizard if unconfigured) |
| `twindevbot start --daemon` | Register and start as background service (macOS launchd / Windows Task Scheduler) |
| `twindevbot stop`           | Stop and unregister background service                       |
| `twindevbot status`         | Check service status                                         |
| `twindevbot show`           | Display saved sessions                                       |
| `twindevbot clear`          | Delete data files (sessions.json, workspaces.json)           |
| `twindevbot help`           | Show help                                                    |

### Setup Wizard

When `twindevbot start` is run and no `.env` file exists, an interactive setup wizard (`setup.ts`) launches:

1. Enter Slack App Token (`xapp-...`)
2. Enter Slack Bot Token (`xoxb-...`)
3. Enter project base directory path (default: Desktop under your home directory)
4. Save `.env` file (0600 permissions on Unix)

---

## Slack Commands

### `/twindevbot init`

Sets the working directory for the channel. Displays subdirectories under `config.baseDir` as buttons, or allows entering a custom path via modal.

### `/twindevbot task [--autopilot]`

Starts a new task thread using the channel's registered directory.

- `--autopilot`: Enables auto-answer mode for AskUserQuestion

### `/twindevbot new <directory> --empty`

Creates an empty directory, then automatically sets the channel directory and starts a task.

### `/twindevbot new <directory> --template <key> [--autopilot]`

Scaffolds a project from a template, then automatically sets the channel directory and starts a task.

### `/twindevbot stop`

Stops the currently running Claude task in the channel.

---

## Event Handling Map

| Slack Event                            | Handler File           | Action                                                   |
| -------------------------------------- | ---------------------- | -------------------------------------------------------- |
| `/twindevbot` slash command            | `claude-command.ts`    | Subcommand routing (init, task, new, stop)               |
| Thread message (runner inactive)       | `claude-command.ts`    | Look up session/workspace -> start/resume Claude         |
| Thread message (runner active)         | `claude-command.ts`    | Send interrupt confirmation UI                           |
| `select_option_*` button click         | `question-handlers.ts` | Single select -> resume                                  |
| `toggle_option_*` button click         | `question-handlers.ts` | Multi-select toggle (UI update only)                     |
| `submit_multi_select_*` button click   | `question-handlers.ts` | Multi-select submit -> resume                            |
| `text_input_*` button click            | `question-handlers.ts` | Open modal                                               |
| `text_input_modal` submission          | `question-handlers.ts` | Modal text -> resume                                     |
| `autopilot_interrupt_yes` button click | `question-handlers.ts` | Disable autopilot -> kill runner -> start new task        |
| `autopilot_interrupt_no` button click  | `question-handlers.ts` | Continue autopilot                                       |
| `normal_interrupt_yes` button click    | `question-handlers.ts` | Kill runner -> start new task with user message           |
| `normal_interrupt_no` button click     | `question-handlers.ts` | Continue existing task                                   |
| `init_select_dir_*` button click       | `init-handlers.ts`     | Select directory -> save to channel-store                |
| `init_custom_input` button click       | `init-handlers.ts`     | Open custom input modal                                  |
| `init_custom_dir_modal` submission     | `init-handlers.ts`     | Validate path -> save to channel-store                   |

---

## Data Models

### Session (Persistent)

```jsonc
// data/sessions.json
{
  "version": 1,
  "sessions": [
    {
      "sessionId": "abc-123",
      "projectName": "my-app",
      "directory": "/Users/user/Desktop/my-app",
      "slackChannelId": "C0123456",
      "slackThreadTs": "1706000000.000000",
      "startedAt": "2024-01-23T10:00:00.000Z",
      "lastActivityAt": "2024-01-23T10:05:00.000Z",
      "autopilot": true
    }
  ]
}
```

### Workspace (File-based)

```jsonc
// data/workspaces.json
{
  "version": 1,
  "workspaces": [
    {
      "threadTs": "1706000000.000000",
      "directory": "/Users/user/Desktop/my-app",
      "projectName": "my-app",
      "channelId": "C0123456",
      "autopilot": false,
      "createdAt": "2024-01-23T10:00:00.000Z"
    }
  ]
}
```

### Channel (File-based)

```jsonc
// data/channels.json
{
  "version": 1,
  "channels": [
    {
      "channelId": "C0123456",
      "directory": "/Users/user/Desktop/my-app",
      "projectName": "my-app"
    }
  ]
}
```

### MultiSelectState (In-memory)

```typescript
interface MultiSelectState {
  selected: Set<number>;      // Selected option indexes
  options: QuestionOption[];
  questionText: string;
  header?: string;
}
// Map<"projectName:messageId", MultiSelectState>
```

### PendingQuestionBatch (In-memory)

```typescript
interface PendingQuestionBatch {
  questions: Question[];
  answers: string[];
  currentIndex: number;
  projectName: string;
  channelId: string;
  createdAt: number;
}
// Map<threadTs, PendingQuestionBatch>
```

### ActionPayloadStore (In-memory)

```typescript
// Map<string, { data: unknown, expiresAt: number }>
// Key patterns:
//   "q:{messageId}" -> StoredQuestionPayload
//   "interrupt:{threadTs}:{userMessageTs}" -> string (user message)
```

---

## Race Condition Prevention

Multiple race condition prevention mechanisms are applied throughout the project.

| Location                 | Mechanism                        | Purpose                                                    |
| ------------------------ | -------------------------------- | ---------------------------------------------------------- |
| `claude-command.ts`      | `pendingSetups` Set              | Prevent concurrent setupClaudeRunner on same thread        |
| `question-handlers.ts`   | `pendingResumes` Set             | Prevent concurrent resumeClaudeWithAnswer on same thread   |
| `active-runners.ts`      | `registerRunner` kills existing  | Prevent duplicate processes on same thread                 |
| `active-runners.ts`      | Instance comparison (stale guard)| Prevent old runner events from unregistering new runner     |
| `claude-runner-setup.ts` | `resultReceived` flag            | Handle result <-> exit event ordering                      |
| `claude-runner-setup.ts` | `handlerTakeover` flag           | Handle process exit during askUser/exitPlanMode             |
| `claude-runner.ts`       | `processedToolUseIds` Set        | Prevent duplicate tool_use event processing                |
| `claude-runner.ts`       | `initEmitted` / `resultEmitted`  | Prevent duplicate init/result event emission                |

---

## Path Resolution

All files are stored relative to the current working directory. Directories are auto-created if missing.

| Item              | Path                              |
| ----------------- | --------------------------------- |
| Config file       | `./.env`                          |
| Session data      | `./data/sessions.json`            |
| Workspaces        | `./data/workspaces.json`          |
| Channel mappings  | `./data/channels.json`            |
| PID file          | `./data/twindevbot.pid`           |
| Logs              | `./logs/twindevbot.{out,err}.log` |

---

## Dependencies

### Runtime

| Package             | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `@slack/bolt`       | Slack App framework (includes Socket Mode)  |
| `@slack/web-api`    | Slack Web API client                        |
| `@slack/types`      | Slack type definitions                      |
| `@inquirer/prompts` | CLI interactive prompts (setup wizard)      |
| `dotenv`            | Environment variable loading                |

### Development

| Package              | Purpose                   |
| -------------------- | ------------------------- |
| `typescript`         | Type checking and build   |
| `vitest`             | Test framework            |
| `@vitest/coverage-v8`| Coverage reporting        |
| `tsx`                | TypeScript execution (dev)|
| `@types/node`        | Node.js type definitions  |

### External Requirements

- **Claude CLI** (`claude` command must be available in PATH)
- **Node.js** >= 18 (ES2022 target)
- **macOS or Windows** for daemon mode; other platforms can run in the foreground (daemon commands disabled)

---

## Environment Variables

| Variable                      | Required | Description                      | Default      |
| ----------------------------- | -------- | -------------------------------- | ------------ |
| `SLACK_BOT_TOKEN`             | Yes      | Slack Bot Token (`xoxb-...`)     | -            |
| `SLACK_APP_TOKEN`             | Yes      | Slack App Token (`xapp-...`)     | -            |
| `TWINDEVBOT_BASE_DIR`         | No       | Project base directory           | Home Desktop |
| `INACTIVITY_TIMEOUT_MINUTES`  | No       | Claude inactivity timeout (min)  | `30`         |
| `LOG_LEVEL`                   | No       | `debug` \| `info` \| `warn` \| `error` | `info`   |

---

## Slack App Required Configuration

### Socket Mode

- Settings > Enable Socket Mode
- Create App-Level Token (`connections:write` scope)

### OAuth & Permissions (Bot Token Scopes)

- `chat:write` - Send messages
- `commands` - Slash Commands
- `channels:history` - Read public channel messages
- `groups:history` - Read private channel messages
- `reactions:write` - Add/remove emoji reactions

### Slash Commands

- `/twindevbot`

### Interactivity & Shortcuts

- Enable (no Request URL needed - Socket Mode)

### Event Subscriptions

- Bot Events: `message.channels`, `message.groups`
- (No Request URL needed - Socket Mode)

The bot must be invited to a channel as a member to receive messages.

---

## Build and Test

```bash
# Build
npm run build              # TypeScript -> dist/

# Development
npm run dev:server         # Hot-reload server via tsx

# Production
npm run start:server       # node dist/server.js

# Test
npm test                   # vitest run (single run)
npm run test:watch         # vitest watch (file change detection)
npm run test:coverage      # Coverage report (v8, text/html/lcov)
```

Tests are located in `src/__tests__/` with 21 test files. `vitest.config.ts` has globals, node environment, restoreMocks, and clearMocks enabled.
