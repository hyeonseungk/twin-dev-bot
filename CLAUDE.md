# Twin Dev Bot

A bridge bot connecting Claude Code and Slack. Create and interact with Claude Code sessions through Slack threads.

## Tech Stack

- **Runtime**: Node.js ≥ 18, TypeScript (ES2022, ESM)
- **Framework**: Slack Bolt (Socket Mode)
- **Testing**: Vitest
- **External dependency**: Claude CLI (`claude` command must be available in PATH)
- **Platform**: Daemon management on macOS and Windows; foreground mode works on any OS with Node + Claude CLI

## Directory Structure

```
twin-dev-bot/
├── src/
│   ├── server.ts                  # Slack Bolt App server (Socket Mode)
│   ├── cli.ts                     # CLI entry point (twindevbot command)
│   ├── setup.ts                   # Interactive CLI setup wizard (.env generation)
│   ├── templates.ts               # Project scaffolding templates
│   ├── core/                      # Core infrastructure
│   │   ├── config.ts              # Environment variable loading (dotenv, lazy init)
│   │   ├── logger.ts              # Level-based logger (file output support)
│   │   ├── paths.ts               # Path configuration (relative to process.cwd())
│   │   └── platform.ts            # Cross-platform utils (OS detection, tilde expansion)
│   ├── claude/                    # Claude execution layer
│   │   ├── claude-runner.ts       # Claude CLI process execution and stream-json parsing
│   │   ├── session-manager.ts     # Claude session CRUD and file persistence
│   │   └── active-runners.ts      # Per-thread active Claude process registry
│   ├── stores/                    # State management (file-based + in-memory)
│   │   ├── workspace-store.ts     # /twindevbot task workspace mapping (thread → directory)
│   │   ├── channel-store.ts       # /twindevbot init channel-directory mapping
│   │   ├── multi-select-state.ts  # Multi-select UI state management (in-memory)
│   │   ├── pending-questions.ts   # Multi-question batch management (in-memory)
│   │   └── action-payload-store.ts # Slack action payload server-side storage (in-memory)
│   ├── slack/                     # Slack UI components
│   │   ├── progress-tracker.ts    # Progress display via Slack reactions/messages
│   │   └── question-blocks.ts     # AskUserQuestion → Slack Block Kit conversion
│   ├── handlers/                  # Slack event handlers
│   │   ├── index.ts               # Handler re-exports
│   │   ├── claude-command.ts      # /twindevbot slash command and message events
│   │   ├── claude-runner-setup.ts # Event handler binding after Claude execution
│   │   ├── question-handlers.ts   # Button clicks, modal submissions, interrupt handling
│   │   └── init-handlers.ts       # Directory selection and channel initialization
│   ├── daemon/                    # Platform-specific daemon management
│   │   ├── index.ts               # Platform factory (createDaemonManager)
│   │   ├── macos.ts               # macOS launchd daemon
│   │   ├── windows.ts             # Windows Task Scheduler daemon
│   │   └── types.ts               # DaemonManager interface
│   ├── i18n/                      # Internationalization
│   │   ├── index.ts               # t() function, initLocale
│   │   └── en.ts                  # English translations
│   ├── utils/                     # Utilities
│   │   ├── slack-message.ts       # Slack API wrappers (postMessage, update, reaction)
│   │   ├── slack-rate-limit.ts    # Slack API auto-retry wrapper (429 handling)
│   │   ├── safe-async.ts          # Async error catch wrapper
│   │   └── display-width.ts       # CJK/emoji string width calculation
│   ├── types/                     # TypeScript type definitions
│   │   ├── index.ts               # Type re-exports
│   │   ├── slack.ts               # Slack types (button values, modal metadata, interrupts)
│   │   ├── conversation.ts        # Question, QuestionOption types
│   │   └── claude-stream.ts       # Claude CLI stream-json output types
│   └── __tests__/                 # Tests
│       ├── helpers/
│       │   └── mock-factories.ts  # Shared mock factories
│       └── *.test.ts              # Per-module test files
├── package.json
├── tsconfig.json
├── vitest.config.ts               # Vitest test configuration
├── README.md                      # User-facing documentation
├── ARCHITECTURE.md                # Detailed architecture document
└── CLAUDE.md                      # This file
```

## Build and Run

```bash
npm run build              # TypeScript build (dist/)
npm run dev:server         # Dev server (tsx hot reload)
npm run start:server       # Production server
npm test                   # Run tests
npm run test:watch         # Test watch mode
npm run test:coverage      # Coverage report
```

## Core Flow

1. `/twindevbot init` → Set working directory for the channel
2. `/twindevbot task` → Create a work thread
3. Thread message → Run Claude CLI (sessions managed via session-manager)
4. Claude's AskUserQuestion → Slack question UI → user responds → resume with `--resume`
5. Claude's ExitPlanMode → auto-approve → resume with `--resume`

## Data Storage

- `data/sessions.json` — Claude sessions (sessionId, directory, threadTs, etc.)
- `data/workspaces.json` — Thread → directory mapping
- `data/channels.json` — Channel → directory mapping
- `data/twindevbot.pid` — Server PID
- `logs/` — Server logs

## Environment Variables (.env)

- `SLACK_BOT_TOKEN` (required) — Slack Bot Token
- `SLACK_APP_TOKEN` (required) — Slack App Token
- `TWINDEVBOT_BASE_DIR` — Project base directory (default: Desktop under your home directory)
- `INACTIVITY_TIMEOUT_MINUTES` — Claude inactivity timeout (default: 30 min)
- `LOG_LEVEL` — Log verbosity (`debug` | `info` | `warn` | `error`, default: `info`)
