import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { existsSync, readdirSync, statSync } from "fs";
import { exec } from "child_process";
import { basename, join } from "path";
import { createLogger } from "../core/logger.js";
import { sessionManager } from "../claude/session-manager.js";
import { postChannelMessage, postThreadMessage } from "../utils/slack-message.js";
import { setupClaudeRunner } from "./claude-runner-setup.js";
import { getTemplate, getTemplateListText, DEFAULT_SCAFFOLD_TIMEOUT } from "../templates.js";
import { t } from "../i18n/index.js";
import { addWorkspace, getWorkspace } from "../stores/workspace-store.js";
import { getChannelDir, setChannelDir } from "../stores/channel-store.js";
import { isRunnerActive, killActiveRunner } from "../claude/active-runners.js";
import { config } from "../core/config.js";
import { setPayload } from "../stores/action-payload-store.js";
import type { InitDirSelectValue, SlackFileInfo } from "../types/index.js";
import { downloadSlackFiles, type DownloadedFile } from "../utils/slack-file-downloader.js";

const log = createLogger("claude-command");

// ─────────────────────────────────────────────────────────────────────────
// Race condition 방지: 동일 스레드에서 동시 setupClaudeRunner 호출 방지
// ─────────────────────────────────────────────────────────────────────────
// Note: setupClaudeRunner는 내부적으로 registerRunner를 호출하며,
// registerRunner는 기존 러너를 kill하므로 최종적으로는 안전하지만,
// 두 프로세스가 동시에 spawn되는 것을 방지하기 위한 가드입니다.

const pendingSetups = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────
// Levenshtein distance (간단한 문자열 유사도 측정)
// ─────────────────────────────────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// ─────────────────────────────────────────────────────────────────────────
// 서브커맨드 파싱
// ─────────────────────────────────────────────────────────────────────────

interface SubcommandResult {
  subcommand: string;
  args: string[];
}

function parseSubcommand(text: string): SubcommandResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  return {
    subcommand: parts[0].toLowerCase(),
    args: parts.slice(1),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 디렉토리명 검증 (커맨드 인젝션 방지)
// ─────────────────────────────────────────────────────────────────────────

const SAFE_DIRNAME_RE = /^[a-zA-Z0-9._-]+$/;

function isValidDirName(name: string): boolean {
  if (name === "." || name === "..") return false;
  if (name.startsWith("-")) return false;
  return SAFE_DIRNAME_RE.test(name);
}

// ─────────────────────────────────────────────────────────────────────────
// 스레드 메시지 타입 가드
// ─────────────────────────────────────────────────────────────────────────

interface ThreadMessageEvent {
  type: string;
  channel: string;
  thread_ts: string;
  ts: string;
  text: string;
  user?: string;
  files?: SlackFileInfo[]; // 첨부 파일
}

function isThreadMessage(event: unknown): event is ThreadMessageEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  // 텍스트가 있거나 파일이 있으면 유효한 메시지
  const hasContent = typeof e.text === "string" || Array.isArray(e.files);
  // file_share subtype은 허용 (파일 첨부 메시지)
  const isAllowedSubtype = !e.subtype || e.subtype === "file_share";
  return (
    hasContent &&
    typeof e.channel === "string" &&
    typeof e.thread_ts === "string" &&
    typeof e.ts === "string" &&
    isAllowedSubtype &&
    !e.bot_id
  );
}

// ─────────────────────────────────────────────────────────────────────────
// init 핸들러 — 채널의 작업 디렉토리 설정
// ─────────────────────────────────────────────────────────────────────────

async function handleChannelInit(
  client: WebClient,
  channelId: string
): Promise<void> {
  const baseDir = config.baseDir;
  if (!existsSync(baseDir)) {
    await postChannelMessage(client, channelId, t("command.baseDirNotFound", { baseDir }));
    return;
  }

  const dirs = readdirSync(baseDir).filter((name) => {
    try {
      return statSync(join(baseDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  // Slack Block Kit 블록 생성
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];

  if (dirs.length === 0) {
    // 디렉토리 없음 — 안내 + 직접 입력 버튼만
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: t("command.initEmpty", { baseDir }) },
    });
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: t("command.initSelectDir") },
    });

    // 디렉토리 버튼 (actions block당 최대 5개)
    for (let i = 0; i < dirs.length; i += 5) {
      const chunk = dirs.slice(i, i + 5);
      blocks.push({
        type: "actions",
        elements: chunk.map((dirName, j) => ({
          type: "button",
          text: { type: "plain_text", text: dirName },
          action_id: `init_select_dir_${i + j}`,
          value: JSON.stringify({ dirName } satisfies InitDirSelectValue),
        })),
      });
    }
  }

  // 직접 입력 버튼 (별도 actions block)
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: t("command.initCustomInput") },
        action_id: "init_custom_input",
      },
    ],
  });

  await client.chat.postMessage({
    channel: channelId,
    text: t("command.initSelectDir"),
    blocks,
  });

  log.info("Init directory selection posted", { channelId, dirCount: dirs.length });
}

// ─────────────────────────────────────────────────────────────────────────
// task 핸들러 — 채널 작업 디렉토리에서 Claude 세션 시작
// ─────────────────────────────────────────────────────────────────────────

async function handleTask(
  client: WebClient,
  channelId: string,
  args: string[],
  userId?: string
): Promise<void> {
  const autopilot = args.includes("--autopilot");

  const channelDir = getChannelDir(channelId);
  if (!channelDir) {
    await postChannelMessage(client, channelId, t("command.taskNoDir"));
    return;
  }

  const { directory, projectName } = channelDir;

  // 디렉토리 존재 확인
  if (!existsSync(directory)) {
    await postChannelMessage(client, channelId,
      t("command.initInvalidDir", { directory })
    );
    return;
  }

  // 채널에 세션 시작 메시지
  const autopilotSuffix = autopilot ? `\n${t("command.autopilotNotice")}` : "";
  const parentText = t("command.taskStarted", { dirName: projectName }) + autopilotSuffix;
  const startResult = await postChannelMessage(client, channelId, parentText);

  if (!startResult.success || !startResult.ts) {
    log.error("Failed to send task message");
    if (userId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: t("command.postFailed"),
        });
      } catch (e) {
        log.error("Failed to send ephemeral error", e);
      }
    }
    return;
  }

  // 스레드에 안내 메시지
  const threadText = t("command.taskSuccess", { dirName: projectName }) + autopilotSuffix;
  await postThreadMessage(client, channelId, threadText, startResult.ts);

  // workspace 등록 (스레드에 메시지 오면 Claude 세션 시작용)
  addWorkspace(startResult.ts, { directory, projectName, channelId, autopilot });
  log.info("Task started", { projectName, directory, threadTs: startResult.ts, autopilot });
}

// ─────────────────────────────────────────────────────────────────────────
// new 핸들러
// ─────────────────────────────────────────────────────────────────────────

interface NewOptions {
  dirName: string;
  mode: "empty" | "template";
  templateKey?: string;
}

function parseNewArgs(args: string[]): NewOptions | null {
  let dirName: string | undefined;
  let mode: "empty" | "template" | undefined;
  let templateKey: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--empty") {
      mode = "empty";
    } else if (arg === "--template") {
      mode = "template";
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        templateKey = args[i + 1].toLowerCase();
        i++;
      }
    } else if (!arg.startsWith("--")) {
      if (!dirName) {
        dirName = arg;
      }
    }
  }

  if (!dirName || !mode) return null;
  if (mode === "template" && !templateKey) return null;

  return { dirName, mode, templateKey };
}

async function handleNew(
  client: WebClient,
  channelId: string,
  args: string[]
): Promise<void> {
  const dirName = args.find((a) => !a.startsWith("--"));

  // 디렉토리 이름이 없으면 사용법 안내
  if (!dirName) {
    await postChannelMessage(client, channelId,
      t("command.newUsage", { templates: getTemplateListText() })
    );
    return;
  }

  if (!isValidDirName(dirName)) {
    await postChannelMessage(client, channelId,
      t("command.invalidDirName", { dirName })
    );
    return;
  }

  // 옵션 파싱
  const newOpts = parseNewArgs(args);

  if (!newOpts) {
    await postChannelMessage(client, channelId,
      t("command.newOptionsRequired", { dirName, templates: getTemplateListText() })
    );
    return;
  }

  const baseDir = config.baseDir;
  if (!existsSync(baseDir)) {
    await postChannelMessage(client, channelId, t("command.baseDirNotFound", { baseDir }));
    return;
  }

  const directory = join(baseDir, newOpts.dirName);
  const projectName = basename(newOpts.dirName);

  // 이미 존재하는 디렉토리 체크
  if (existsSync(directory)) {
    await postChannelMessage(client, channelId,
      t("command.dirAlreadyExists", { dirName: newOpts.dirName })
    );
    return;
  }

  if (newOpts.mode === "empty") {
    // 빈 디렉토리 생성
    try {
      const { mkdirSync } = await import("fs");
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await postChannelMessage(client, channelId,
        t("command.errorOccurred", { error: errMsg })
      );
      return;
    }

    await postChannelMessage(client, channelId,
      t("command.emptyDirCreated", { dirName: newOpts.dirName })
    );
  } else {
    // 템플릿으로 프로젝트 생성
    const template = getTemplate(newOpts.templateKey!);

    if (!template) {
      await postChannelMessage(client, channelId,
        t("command.templateNotFound", { templateKey: newOpts.templateKey!, templates: getTemplateListText() })
      );
      return;
    }

    let scaffoldResult: string | ((cwd: string) => Promise<void>);
    try {
      scaffoldResult = template.scaffold(projectName);
    } catch (err) {
      await postChannelMessage(client, channelId,
        `Failed to prepare scaffold for template "${template.name}": ${String(err)}`
      );
      return;
    }

    if (typeof scaffoldResult === "string") {
      // 셸 명령어 모드
      const messageResult = await postChannelMessage(client, channelId,
        t("command.creatingProject", { templateName: template.name, command: scaffoldResult })
      );

      // 진행 상태 업데이트 (5초마다 점 추가)
      let dots = 0;
      const progressInterval = setInterval(async () => {
        if (!messageResult.success || !messageResult.ts) return;
        dots = (dots + 1) % 4;
        const dotStr = ".".repeat(dots + 1);
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageResult.ts,
            text: t("command.creatingProject", { templateName: template.name, command: scaffoldResult }) + dotStr,
          });
        } catch {}
      }, 5000);

      try {
        await execAsync(scaffoldResult, baseDir, template.timeout ?? DEFAULT_SCAFFOLD_TIMEOUT);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await postChannelMessage(client, channelId,
          t("command.errorOccurred", { error: errMsg })
        );
        return;
      } finally {
        clearInterval(progressInterval);
      }
    } else {
      // Node.js API 모드 (크로스 플랫폼)
      const messageResult = await postChannelMessage(client, channelId,
        t("command.creatingProject", { templateName: template.name, command: template.name })
      );

      // 진행 상태 업데이트 (5초마다 점 추가)
      let dots = 0;
      const progressInterval = setInterval(async () => {
        if (!messageResult.success || !messageResult.ts) return;
        dots = (dots + 1) % 4;
        const dotStr = ".".repeat(dots + 1);
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageResult.ts,
            text: t("command.creatingProject", { templateName: template.name, command: template.name }) + dotStr,
          });
        } catch {}
      }, 5000);

      try {
        await scaffoldResult(baseDir);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await postChannelMessage(client, channelId,
          t("command.errorOccurred", { error: errMsg })
        );
        return;
      } finally {
        clearInterval(progressInterval);
      }
    }

    await postChannelMessage(client, channelId,
      t("command.projectCreated", { templateName: template.name, dirName: newOpts.dirName })
    );
  }

  // new 성공 후 채널 디렉토리 자동 설정 + task 시작
  setChannelDir(channelId, { directory, projectName });
  const autopilotArgs = args.includes("--autopilot") ? ["--autopilot"] : [];
  await handleTask(client, channelId, autopilotArgs);
}

function execAsync(command: string, cwd?: string, timeout = DEFAULT_SCAFFOLD_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout, cwd, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// stop 핸들러
// ─────────────────────────────────────────────────────────────────────────

async function handleStop(
  client: WebClient,
  channelId: string
): Promise<void> {
  // 채널의 최근 메시지 조회하여 활성 스레드 찾기
  try {
    const result = await client.conversations.history({
      channel: channelId,
      limit: 100,
    });

    if (!result.messages) {
      await postChannelMessage(client, channelId, t("command.noActiveTask"));
      return;
    }

    // 스레드가 있는 메시지 중 활성 러너가 있는지 확인
    for (const msg of result.messages) {
      const threadTs = msg.thread_ts || msg.ts;
      if (threadTs && isRunnerActive(threadTs)) {
        killActiveRunner(threadTs);
        await postChannelMessage(client, channelId, t("command.stopped"));
        log.info("Task stopped by user command", { channelId, threadTs });
        return;
      }
    }

    await postChannelMessage(client, channelId, t("command.noActiveTask"));
  } catch (error) {
    log.error("Failed to stop task", error);
    await postChannelMessage(client, channelId, t("command.noActiveTask"));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 사용법 안내
// ─────────────────────────────────────────────────────────────────────────

async function showUsage(client: WebClient, channelId: string): Promise<void> {
  await postChannelMessage(client, channelId,
    t("command.help", { templates: getTemplateListText(), baseDir: config.baseDir })
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 메인 커맨드 등록
// ─────────────────────────────────────────────────────────────────────────

export function registerClaudeCommand(app: App): void {
  // /twindevbot 명령어 처리 — 서브커맨드 라우터
  app.command("/twindevbot", async ({ ack, body, client }) => {
    await ack();
    try {
      const channelId = body.channel_id;
      const parsed = parseSubcommand(body.text);

      if (!parsed) {
        await showUsage(client, channelId);
        return;
      }

      log.info("Command received", {
        subcommand: parsed.subcommand,
        args: parsed.args,
        channel: channelId,
      });

      switch (parsed.subcommand) {
        case "init":
          await handleChannelInit(client, channelId);
          break;

        case "task":
          await handleTask(client, channelId, parsed.args, body.user_id);
          break;

        case "new":
          await handleNew(client, channelId, parsed.args);
          break;

        case "stop":
          await handleStop(client, channelId);
          break;

        default: {
          const knownCommands = ["init", "task", "new", "stop"];
          const suggestion = knownCommands.find(cmd =>
            levenshteinDistance(parsed.subcommand, cmd) <= 2
          );
          if (suggestion) {
            await postChannelMessage(client, channelId,
              t("command.didYouMean", { suggestion })
            );
          } else {
            await showUsage(client, channelId);
          }
          break;
        }
      }
    } catch (error) {
      log.error("Error handling /twindevbot command", error);
      try {
        await postChannelMessage(client, body.channel_id, `:warning: An error occurred while processing your command.`);
      } catch {
        // Best effort - don't let error reporting fail the handler
      }
    }
  });

  // 스레드 메시지 처리 (사용자 응답)
  // sessionManager에 세션이 있으면 --resume, workspace만 있으면 새 세션 시작
  app.event("message", async ({ event, client }) => {
    try {
      const raw = event as unknown as Record<string, unknown>;
      log.info("Message event received", {
        type: raw.type,
        subtype: raw.subtype,
        channel: raw.channel,
        thread_ts: raw.thread_ts,
        ts: raw.ts,
        bot_id: raw.bot_id,
        text: typeof raw.text === "string" ? raw.text.slice(0, 50) : undefined,
      });

      // subtype(message_changed 등), 봇, 텍스트 없음, 채널 없음, 스레드 아닌 메시지 필터링
      if (!isThreadMessage(event)) return;

      const threadTs = event.thread_ts;
      const text = event.text || "";
      const userMessageTs = event.ts;
      const slackFiles = event.files || [];

      // 파일 다운로드 (파일이 있는 경우)
      let downloadedFiles: DownloadedFile[] = [];
      if (slackFiles.length > 0) {
        log.info("Message contains files, downloading", {
          threadTs,
          fileCount: slackFiles.length,
          fileNames: slackFiles.map(f => f.name),
        });

        try {
          const downloadResult = await downloadSlackFiles(slackFiles, config.slack.botToken);
          downloadedFiles = downloadResult.success;

          // 실패/스킵된 파일 경고 메시지
          const warnings: string[] = [];
          for (const f of downloadResult.failed) {
            warnings.push(`\u274C ${f.file.name}: ${f.error}`);
          }
          for (const f of downloadResult.skipped) {
            warnings.push(`\u26A0\uFE0F ${f.file.name}: ${f.reason}`);
          }

          if (warnings.length > 0) {
            await postThreadMessage(
              client,
              event.channel,
              `Some files could not be processed:\n${warnings.join("\n")}`,
              threadTs
            );
          }

          log.info("File download complete", {
            threadTs,
            successCount: downloadedFiles.length,
            failedCount: downloadResult.failed.length,
            skippedCount: downloadResult.skipped.length,
          });
        } catch (error) {
          log.error("Failed to download files", error);
          await postThreadMessage(
            client,
            event.channel,
            `\u274C Failed to download attached files: ${error instanceof Error ? error.message : String(error)}`,
            threadTs
          );
        }
      }

      // 텍스트도 파일도 없으면 무시
      if (!text.trim() && downloadedFiles.length === 0) {
        log.debug("Message has no text and no valid files, ignoring", { threadTs });
        return;
      }

      // 러너가 실행 중이면 개입(interrupt) 확인 메시지를 전송
      // autopilot 모드와 일반 모드를 구분하여 각각 다른 안내 메시지를 표시
      if (isRunnerActive(threadTs)) {
        const existingSession = sessionManager.getByThread(threadTs);
        const workspace = getWorkspace(threadTs);
        const isAutopilot = existingSession?.autopilot || workspace?.autopilot;

        // userMessage를 서버 사이드에 저장 (Slack action.value ~2,000바이트 제한 대응)
        const interruptKey = `interrupt:${threadTs}:${userMessageTs}`;
        setPayload(interruptKey, text);

        const interruptValue = JSON.stringify({
          threadTs,
          channelId: event.channel,
          projectName: existingSession?.projectName || workspace?.projectName || "unknown",
          userMessageTs,
        });

        if (isAutopilot) {
          log.info("Autopilot runner active, sending interrupt confirmation", { threadTs });
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: t("command.autopilotInterruptConfirm"),
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: t("command.autopilotInterruptConfirm") },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: t("command.autopilotInterruptYes") },
                    action_id: "autopilot_interrupt_yes",
                    value: interruptValue,
                    style: "danger",
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: t("command.autopilotInterruptNo") },
                    action_id: "autopilot_interrupt_no",
                    value: interruptValue,
                  },
                ],
              },
            ],
          });
          return;
        }
        // 일반 모드: 러너가 실행 중이면 개입 확인 메시지 전송
        log.info("Normal runner active, sending interrupt confirmation", { threadTs });
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: t("command.normalInterruptConfirm"),
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: t("command.normalInterruptConfirm") },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: t("command.normalInterruptYes") },
                  action_id: "normal_interrupt_yes",
                  value: interruptValue,
                  style: "danger",
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: t("command.normalInterruptNo") },
                  action_id: "normal_interrupt_no",
                  value: interruptValue,
                },
              ],
            },
          ],
        });
        return;
      }

      // 1. 기존 세션이 있으면 resume
      const session = sessionManager.getByThread(threadTs);
      if (session) {
        log.info("Resuming session from thread message", {
          projectName: session.projectName,
          threadTs,
          text,
        });

        // Race condition 방지: 이미 설정 중이면 무시
        if (pendingSetups.has(threadTs)) {
          log.debug("Setup already in progress for thread", { threadTs });
          return;
        }

        pendingSetups.add(threadTs);
        try {
          // 파일만 있고 텍스트가 없으면 기본 프롬프트 사용
          const prompt = text.trim() || (downloadedFiles.length > 0 ? "Please analyze the attached file(s)." : "");
          setupClaudeRunner({
            client,
            channelId: session.slackChannelId,
            threadTs: session.slackThreadTs,
            directory: session.directory,
            projectName: session.projectName,
            prompt,
            sessionId: session.sessionId,
            userMessageTs,
            autopilot: session.autopilot,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          });
          // setupClaudeRunner는 동기 함수이며 runner 등록까지 완료됨
          pendingSetups.delete(threadTs);
        } catch (error) {
          pendingSetups.delete(threadTs);
          log.error("Failed to setup Claude runner for session resume", error);
          await postThreadMessage(client, event.channel, t("runner.errorOccurred", { error: error instanceof Error ? error.message : String(error) }), threadTs);
        }
        return;
      }

      // 2. workspace가 있으면 새 Claude 세션 시작
      const workspace = getWorkspace(threadTs);
      if (workspace) {
        log.info("Starting new Claude session from workspace", {
          projectName: workspace.projectName,
          threadTs,
          text,
          fileCount: downloadedFiles.length,
        });

        // Race condition 방지: 이미 설정 중이면 무시
        if (pendingSetups.has(threadTs)) {
          log.debug("Setup already in progress for thread", { threadTs });
          return;
        }

        pendingSetups.add(threadTs);
        try {
          // 파일만 있고 텍스트가 없으면 기본 프롬프트 사용
          const prompt = text.trim() || (downloadedFiles.length > 0 ? "Please analyze the attached file(s)." : "");
          setupClaudeRunner({
            client,
            channelId: workspace.channelId,
            threadTs,
            directory: workspace.directory,
            projectName: workspace.projectName,
            prompt,
            userMessageTs,
            autopilot: workspace.autopilot,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          });
          // setupClaudeRunner는 동기 함수이며 runner 등록까지 완료됨
          pendingSetups.delete(threadTs);
        } catch (error) {
          pendingSetups.delete(threadTs);
          log.error("Failed to setup Claude runner for new workspace session", error);
          await postThreadMessage(client, event.channel, t("runner.errorOccurred", { error: error instanceof Error ? error.message : String(error) }), threadTs);
        }
        return;
      }

      // 세션도 워크스페이스도 없는 스레드 — 사용자에게 안내
      log.debug("No session or workspace found for thread", { threadTs });
      if (event.user) {
        try {
          await client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: t("session.expired"),
            thread_ts: threadTs,
          });
        } catch (ephemeralError) {
          log.error("Failed to send stale thread notice", ephemeralError);
        }
      }
    } catch (error) {
      log.error("Error handling message event", error);
    }
  });
}
