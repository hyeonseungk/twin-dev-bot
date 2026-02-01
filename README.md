# TwinDevBot

<p align="center">
  <img src="logo.png" alt="TwinDevBot" width="150" />
</p>

A **Slack** bot that lets you develop with **Claude Code** through Slack conversations — **from anywhere**.

TwinDevBot connects your Slack workspace to Claude Code running on your machine. You send messages in Slack threads, and Claude Code works on your local codebase in real time.

## When is this useful?

- You want to give Claude Code development tasks **remotely** (e.g. from your phone or another computer)
- You want to manage multiple projects through **separate Slack channels**
- You want to manage multiple tasks for a single project — each task lives in its own **Slack thread**
- You want Claude Code to work **autonomously** on tasks while you're away (Autopilot mode)

> [!CAUTION]
> **TwinDevBot launches Claude Code with the `--dangerously-skip-permissions` flag.** This means Claude Code can read, write, and execute files on your machine **without asking for permission**.
>
> Only use TwinDevBot if you fully understand what this means. The source code is fully open on GitHub. **No one is responsible for any incidents caused by using TwinDevBot.**

---

## Requirements

Before you begin, make sure you have the following:

1. **Node.js 18 or later**
   - Check by running `node --version` in your terminal
   - If not installed, download from [nodejs.org](https://nodejs.org)

2. **Claude Code CLI**
   - The `claude` command must be available in your terminal
   - Install with: `npm install -g @anthropic-ai/claude-code`
   - Verify by running: `claude --version`

3. **macOS for background service**
   - `twindevbot start --daemon`, `stop`, and `status` are supported on macOS (launchd)
   - On other platforms, run in the foreground with `twindevbot start`

4. **A Slack workspace** where you have permission to install apps

---

## Step 1: Create a Slack App

You need to create a Slack App in your workspace. This is a one-time setup.

### 1.1 Create the app

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Enter an app name (e.g. `TwinDevBot`) and select your workspace
5. Click **"Create App"**

### 1.2 Enable Socket Mode

1. In the left sidebar, click **"Socket Mode"**
2. Toggle **"Enable Socket Mode"** to ON
3. You will be asked to create an **App-Level Token**:
   - Add the `connections:write` scope
   - Click **"Generate"**
4. **Copy the token** (starts with `xapp-`) — you will need this later

### 1.3 Add a Slash Command

1. In the left sidebar, click **"Slash Commands"**
2. Click **"Create New Command"**
3. Fill in:
   - **Command:** `/twindevbot`
   - **Short Description:** `TwinDevBot Commands`
   - **Usage Hint:** `init | task | new | stop`
4. Click **"Save"**

### 1.4 Set Bot Permissions

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to **"Scopes"** → **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add all of the following:

| Scope | What it's for |
|-------|---------------|
| `chat:write` | Send messages to channels |
| `commands` | Handle the `/twindevbot` slash command |
| `reactions:write` | Add emoji reactions to show progress |
| `channels:history` | Read messages in public channels |
| `groups:history` | Read messages in private channels |

### 1.5 Enable Event Subscriptions

1. In the left sidebar, click **"Event Subscriptions"**
2. Toggle **"Enable Events"** to ON
3. Expand **"Subscribe to bot events"**
4. Click **"Add Bot User Event"** and add:
   - `message.channels` (messages in public channels)
   - `message.groups` (messages in private channels)
5. Click **"Save Changes"**

### 1.6 Enable Interactivity

1. In the left sidebar, click **"Interactivity & Shortcuts"**
2. Toggle **"Interactivity"** to ON
3. Click **"Save Changes"**

> You do **not** need to enter a Request URL — Socket Mode handles this automatically.

### 1.7 Install the App to Your Workspace

1. In the left sidebar, click **"Install App"**
2. Click **"Install to Workspace"**
3. Review the permissions and click **"Allow"**
4. **Copy the Bot Token** (starts with `xoxb-`) — you will need this later

---

## Step 2: Install TwinDevBot

Open your terminal and run:

```bash
npm install -g twin-dev-bot
```

Verify the installation:

```bash
twindevbot help
```

---

## Step 3: Start the Server

Navigate to the directory where you want TwinDevBot to store its data (your Desktop is recommended). For example:

```bash
cd ~/Desktop
```

Then start the server:

```bash
twindevbot start
```

**If this is your first time**, a setup wizard will appear asking for:

1. **Slack App Token** — paste the `xapp-...` token from Step 1.2
2. **Slack Bot Token** — paste the `xoxb-...` token from Step 1.7
3. **Project base directory** — the parent folder where your projects live (default: your Desktop folder)

After completing the setup, the server will start and connect to Slack.

### Running in the Background (Recommended)

To keep TwinDevBot running even after you close the terminal:

```bash
twindevbot start --daemon
```

This registers TwinDevBot as a background service that starts automatically on login (macOS launchd).

### Managing the Server

```bash
twindevbot status     # Check if the background service is running
twindevbot stop       # Stop and unregister the background service
twindevbot show       # View saved Claude sessions
twindevbot clear      # Delete saved data (sessions + workspaces)
```

> `status` and `stop` are available only when daemon mode is supported (macOS).

---

## Step 4: Invite the Bot to a Slack Channel

Before using TwinDevBot in any channel, you must **invite the bot**:

1. Go to the Slack channel where you want to use TwinDevBot
2. Type `/invite @TwinDevBot` (use the name you gave your Slack app)
3. The bot should now appear as a channel member

> The bot **cannot receive messages** in channels where it is not a member.

---

## Using TwinDevBot in Slack

### Setting Up a Channel

Before starting any work, tell TwinDevBot which project directory to use for this channel:

```
/twindevbot init
```

This shows a list of folders inside your project base directory. Click a folder button to select it, or click **"Enter path manually"** to type a custom path.

You only need to do this **once per channel**.

### Starting a Task

Once a channel is set up, start a new work session:

```
/twindevbot task
```

This creates a message in the channel. **Click on the thread** of that message to begin chatting with Claude Code.

Type your instructions in the thread (e.g. "Create a login page with email and password fields"), and Claude Code will start working on your local codebase.

### Creating a New Project

**Create an empty project:**

```
/twindevbot new my-app --empty
```

**Create a project from a template:**

```
/twindevbot new my-app --template react
```

This creates the project in your base directory, sets it as the channel's working directory, and opens a new thread automatically.

**Available templates:**

| Category | Templates |
|----------|-----------|
| Frontend | `react`, `nextjs`, `vue`, `nuxt`, `sveltekit`, `angular`, `react-native-expo`, `react-native-bare`, `flutter` |
| Backend | `express`, `nestjs`, `fastify`, `spring-boot`, `django`, `fastapi`, `go`, `rails`, `laravel` |

### Autopilot Mode

In Autopilot mode, Claude Code automatically answers its own questions and keeps working without waiting for your input. Great for **small tasks** or **kicking off work right before bed** — let Claude handle it while you sleep.

```
/twindevbot task --autopilot
```

Or with a new project:

```
/twindevbot new my-app --template react --autopilot
```

In Autopilot mode:
- Claude automatically selects the recommended option for each question
- All questions and auto-selected answers are logged in the thread for your review
- You can **interrupt** Autopilot by sending a message in the thread — you'll be asked to confirm before it stops

### Stopping a Running Task

To cancel the current Claude Code task in a channel:

```
/twindevbot stop
```

### Getting Help

```
/twindevbot
```

Use `/twindevbot` with no subcommand to show the help message. Any unknown subcommand shows the same help.

---

## How a Conversation Works

Here's what happens step by step:

1. **You run** `/twindevbot task` → a parent message appears in the channel
2. **You type** your instructions in the **thread** of that message (e.g. "Add a dark mode toggle")
3. **Claude Code starts working** — you'll see emoji reactions showing progress:
   - 👀 = Message received
   - ⚙️ = Working (with tool usage updates like "Reading file", "Editing file", etc.)
   - ✅ = Completed
   - ❌ = Error occurred
4. **If Claude has a question**, buttons appear in the thread:
   - Click a button to select an option
   - Or click **"Custom Input"** to type your own answer
   - For multi-select questions, toggle options and click **"Submit Selection"**
5. **When the task is done**, the elapsed time is displayed
6. **Send another message** in the same thread to continue working — Claude remembers the entire conversation

### Interrupting a Running Task

If Claude is still working and you send a new message in the thread, you'll see a confirmation prompt:

- In **normal mode**: you'll be asked whether to stop the current task and start a new one
- In **Autopilot mode**: you'll be asked to stop autopilot before running your new message

Click **Yes** to stop the current task and start your new one, or **No** to let it finish.

---

## Inactivity Timeout

If Claude Code receives no events for **30 minutes** (configurable), the process is automatically terminated to save resources. You'll see a notification in the thread. Simply send a new message to restart.

To change the timeout, add this to your `.env` file:

```
INACTIVITY_TIMEOUT_MINUTES=60
```

---

## Configuration Reference

All settings are stored in the `.env` file in the directory where you started TwinDevBot.

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Yes | Slack Bot Token (`xoxb-...`) | — |
| `SLACK_APP_TOKEN` | Yes | Slack App Token (`xapp-...`) | — |
| `TWINDEVBOT_BASE_DIR` | No | Parent directory for projects | Home Desktop |
| `INACTIVITY_TIMEOUT_MINUTES` | No | Minutes before idle Claude is stopped | `30` |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` | `info` |

---

## File Locations

TwinDevBot stores its data in the directory where you started the server:

| File | Purpose |
|------|---------|
| `.env` | Configuration (Slack tokens, settings) |
| `data/sessions.json` | Saved Claude Code sessions |
| `data/workspaces.json` | Thread-to-directory mappings |
| `data/channels.json` | Channel-to-directory mappings |
| `data/twindevbot.pid` | Server process ID |
| `logs/twindevbot.err.log` | Error log |
| `logs/twindevbot.out.log` | Output log |

---

## Troubleshooting

### "Claude CLI is not installed or not found in PATH"

Make sure the `claude` command works in your terminal:

```bash
claude --version
```

If not, install it:

```bash
npm install -g @anthropic-ai/claude-code
```

### Bot doesn't respond to messages

1. Make sure the TwinDevBot server is running:
   - If you're using daemon mode (macOS): `twindevbot status`
   - Otherwise, confirm the `twindevbot start` process is still running
2. Make sure the bot is invited to the channel: `/invite @TwinDevBot`
3. Make sure you're typing in a **thread**, not directly in the channel

### "Session expired" message

Sessions are cleaned up after 24 hours of inactivity (cleanup runs hourly). Start a new session with `/twindevbot task`.

### Server won't start

Check the error log for details:

```bash
tail -f ./logs/twindevbot.err.log
```

(Run from the directory where you started TwinDevBot)

### Something seems wrong with the server

Check the error log:

```bash
tail -f ./logs/twindevbot.err.log
```

To clear all saved data and start fresh:

```bash
# If you're running in daemon mode (macOS)
twindevbot stop
twindevbot clear
twindevbot start --daemon
```

If you're running in the foreground, stop it with Ctrl+C first, then run:

```bash
twindevbot clear
twindevbot start
```

---

## License

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) — You are free to use, modify, and distribute this software. If you distribute modified versions or run it as a network service, you must release your source code under the same license.
