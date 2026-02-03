import type { WebClient } from "@slack/web-api";
import { createLogger } from "../core/logger.js";
import {
  runClaude,
  type AskUserEvent,
  type InitEvent,
  type TextEvent,
  type ToolUseEvent,
  type ResultEvent,
} from "../claude/claude-runner.js";
import { sessionManager } from "../claude/session-manager.js";
import { buildQuestionBlocks } from "../slack/question-blocks.js";
import { initState } from "../stores/multi-select-state.js";
import { postThreadMessage } from "../utils/slack-message.js";
import { t } from "../i18n/index.js";
import { ProgressTracker } from "../slack/progress-tracker.js";
import type { Question } from "../types/conversation.js";
import { safeAsync } from "../utils/safe-async.js";
import { registerRunner, unregisterRunner, refreshActivity } from "../claude/active-runners.js";
import { removeWorkspace } from "../stores/workspace-store.js";
import { config } from "../core/config.js";
import { initPendingBatch } from "../stores/pending-questions.js";
import { setPayload } from "../stores/action-payload-store.js";
import type { DownloadedFile } from "../utils/slack-file-downloader.js";

const log = createLogger("claude-runner-setup");

/**
 * 텍스트 메시지를 버퍼에 모아서 일정 시간 후 한 번에 전송.
 * Slack API rate limit을 방지하기 위해 사용.
 */
class TextBuffer {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private sendFn: (text: string) => Promise<void>,
    private flushDelayMs = 2000,
  ) {}

  append(text: string): void {
    this.buffer.push(text);
    this.resetTimer();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const combined = this.buffer.join("\n");
    this.buffer = [];
    await this.sendFn(combined);
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch((err) =>
        log.error("TextBuffer flush error", err)
      );
    }, this.flushDelayMs);
  }
}

export interface SetupClaudeRunnerOptions {
  client: WebClient;
  channelId: string;
  threadTs: string;
  directory: string;
  projectName: string;
  prompt: string;
  sessionId?: string;
  userMessageTs?: string;
  autopilot?: boolean;
  files?: DownloadedFile[]; // 첨부 파일 (Slack에서 다운로드된)
}

/**
 * Claude 실행 및 이벤트 핸들러 설정
 */
export function setupClaudeRunner(options: SetupClaudeRunnerOptions): void {
  const { client, channelId, threadTs, directory, projectName, prompt, sessionId, userMessageTs, autopilot, files } = options;

  // threadTs 유효성 검사
  if (!threadTs) {
    log.error("setupClaudeRunner called without threadTs", {
      channelId,
      projectName,
      sessionId,
    });
    throw new Error("threadTs is required");
  }

  log.info("setupClaudeRunner", { channelId, threadTs, projectName, sessionId });

  // 진행 상태 추적기 생성
  const tracker = new ProgressTracker({ client, channelId, threadTs, userMessageTs });
  const receivedPromise = tracker.markReceived();

  // result/exit 이벤트 간 레이스 컨디션 방지용 상태
  let resultReceived = false;
  let resultPromise: Promise<void> | null = null;
  let completionHandled = false;
  let errorHandled = false;

  // askUser/exitPlanMode ↔ exit 이벤트 간 레이스 컨디션 방지용 상태
  // handlerTakeover: askUser/exitPlanMode 핸들러가 비동기 작업 중임을 표시
  // processExitedEarly: handlerTakeover 중 프로세스가 예상치 못하게 종료됨
  let handlerTakeover = false;
  let processExitedEarly = false;

  // 텍스트 버퍼 (2초간 모아서 한 번에 전송)
  const textBuffer = new TextBuffer(
    async (text) => {
      await postThreadMessage(client, channelId, text, threadTs);
    },
    2000,
  );

  const runner = runClaude({
    directory,
    prompt,
    sessionId,
    files,
  });

  // 활성 러너 등록 (동시 실행 방지 + 비활성 타임아웃)
  registerRunner(threadTs, runner, {
    onTimeout: () => {
      log.warn("Runner killed by inactivity timeout", { projectName, threadTs });
      const timeoutMsg = t("runner.inactivityTimeout", { minutes: config.inactivityTimeoutMinutes });
      postThreadMessage(client, channelId, timeoutMsg, threadTs)
        .catch((err) => log.error("Failed to send timeout message", err));
      tracker.markError(timeoutMsg)
        .catch((err) => log.error("Failed to mark timeout error", err));
    },
  });

  // 이벤트 핸들러 설정
  runner.on("init", safeAsync(async (event: InitEvent) => {
    refreshActivity(threadTs, runner);

    // 새 세션인 경우에만 sessionManager에 추가
    if (!sessionId) {
      sessionManager.add({
        sessionId: event.sessionId,
        projectName,
        directory,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        autopilot: autopilot ?? false,
      });

      // 세션이 생성되었으므로 workspace 매핑 제거 (메모리 누수 방지)
      removeWorkspace(threadTs);

      log.info("Session started", { sessionId: event.sessionId, projectName, threadTs });
    } else {
      // resume인 경우 활동 시간 업데이트
      sessionManager.updateActivity(event.sessionId);
      log.info("Session resumed", { sessionId: event.sessionId, projectName, threadTs });
    }

    // markReceived()의 👀 리액션이 완료된 후 ⚙️로 교체해야
    // 두 리액션이 동시에 남는 레이스 컨디션을 방지
    await receivedPromise;
    await tracker.markWorking();
  }, "init"));

  // Claude 텍스트 출력 처리 (버퍼링하여 rate limit 방지)
  runner.on("text", safeAsync(async (event: TextEvent) => {
    refreshActivity(threadTs, runner);
    if (!event.text.trim()) return;

    textBuffer.append(event.text);
  }, "text"));

  // 도구 사용 처리 (AskUserQuestion, ExitPlanMode 제외 — 별도 이벤트로 처리)
  runner.on("toolUse", safeAsync(async (event: ToolUseEvent) => {
    refreshActivity(threadTs, runner);
    if (event.toolName === "AskUserQuestion") return;
    if (event.toolName === "ExitPlanMode") return;

    await tracker.updateToolUse(event.toolName);
  }, "toolUse"));

  // ExitPlanMode 처리 — stdin이 "ignore"라 CLI가 승인을 받을 수 없으므로
  // 프로세스를 kill하고 "계획 승인" 메시지로 resume하여 plan mode를 빠져나감
  runner.on("exitPlanMode", safeAsync(async () => {
    handlerTakeover = true;
    await textBuffer.flush();

    // flush 중 프로세스가 예상치 못하게 종료된 경우 → exit 핸들러가 에러 처리 완료함
    if (processExitedEarly) {
      log.warn("Process exited during exitPlanMode handling, aborting resume", { projectName });
      return;
    }

    log.info("ExitPlanMode detected, auto-approving", { projectName, autopilot });

    await tracker.markPlanApproved();

    const currentSessionId = runner.currentSessionId;
    unregisterRunner(threadTs, runner);
    runner.kill();

    // markPlanApproved 중 프로세스가 종료된 경우 resume 방지
    if (processExitedEarly) {
      log.warn("Process exited during exitPlanMode approval, aborting resume", { projectName });
      return;
    }

    if (currentSessionId) {
      try {
        setupClaudeRunner({
          client,
          channelId,
          threadTs,
          directory,
          projectName,
          prompt: t("runner.planApproved"),
          sessionId: currentSessionId,
          autopilot: autopilot ?? false,
        });
      } catch (error) {
        log.error("Failed to resume after ExitPlanMode", { projectName, error });
        await postThreadMessage(client, channelId, t("runner.autopilotResumeFailed"), threadTs);
        await tracker.markError(t("runner.autopilotResumeFailed"));
      }
    } else {
      log.error("No sessionId for ExitPlanMode resume", { projectName });
      await postThreadMessage(client, channelId, t("runner.autopilotNoSession"), threadTs);
      await tracker.markError(t("runner.autopilotNoSession"));
    }
  }, "exitPlanMode"));

  // AskUserQuestion 처리 - Slack 스레드로 질문 전송
  // ─────────────────────────────────────────────────────────────────────────
  // 흐름: Claude CLI → askUser 이벤트 → Slack 전송 → 프로세스 kill → 대기
  //       → 사용자 Slack 응답 → question-handlers.ts → --resume으로 재시작
  //
  // autopilot 모드: 첫 번째 옵션을 즉시 자동 선택하고 resume
  //
  // 중요: Slack 전송 완료 후 반드시 runner.kill()을 호출해야 함
  //       - Claude CLI의 stdin이 "ignore"라서 응답을 받을 수 없음
  //       - kill하지 않으면 Claude가 "Answer questions?" 에러를 받고
  //         같은 질문을 다른 tool_use_id로 무한 반복함
  // ─────────────────────────────────────────────────────────────────────────
  runner.on("askUser", safeAsync(async (event: AskUserEvent) => {
    handlerTakeover = true;
    await textBuffer.flush();

    // flush 중 프로세스가 예상치 못하게 종료된 경우 → exit 핸들러가 에러 처리 완료함
    if (processExitedEarly) {
      log.warn("Process exited during askUser handling, aborting", { projectName });
      return;
    }

    const questions = event.input.questions as Question[];

    log.info("AskUserQuestion received", {
      projectName,
      questionCount: questions.length,
      autopilot,
    });

    // 빈 질문 배열 방어 — 사용자에게 알림 후 세션 종료
    if (!questions || questions.length === 0) {
      log.warn("AskUserQuestion received with no questions, terminating", { projectName });
      await postThreadMessage(client, channelId, t("runner.emptyQuestions"), threadTs);
      await tracker.markError(t("runner.emptyQuestions"));
      unregisterRunner(threadTs, runner);
      runner.kill();
      return;
    }

    const messageId = `ask-${threadTs}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const firstQuestion = questions[0];

    if (autopilot) {
      // ── Autopilot: recommended 옵션 우선, 없으면 첫 번째 옵션 자동 선택 ──
      // multiSelect인 경우 recommended 옵션 모두 선택
      const pickBestOptions = (options: Question["options"], multiSelect?: boolean): string[] => {
        if (multiSelect) {
          const recommended = options.filter(o => /recommended/i.test(o.label));
          if (recommended.length > 0) return recommended.map(o => o.label);
        } else {
          const recommended = options.find(o => /recommended/i.test(o.label));
          if (recommended) return [recommended.label];
        }
        return [options[0]?.label || "N/A"];
      };

      const parts = questions.map(q => {
        const answers = pickBestOptions(q.options, q.multiSelect);
        const answer = answers.join(", ");
        const header = q.header || q.question.slice(0, 50);
        return { question: q, header, answer };
      });

      const combinedPrompt = questions.length === 1
        ? parts[0].answer
        : parts.map(p => `[${p.header}]: ${p.answer}`).join("\n");
      const displayAnswer = questions.length === 1
        ? parts[0].answer
        : parts.map(p => `${p.header}: ${p.answer}`).join(", ");

      log.info("Autopilot auto-selecting", { projectName, selectedLabel: displayAnswer });

      // Slack에 질문 + 자동 선택 결과를 완료 상태로 표시
      // 복수 질문: 각 질문을 개별 메시지로 전송하여 리뷰 시 어떤 질문에 어떤 답변이 선택되었는지 명확히 표시
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const answerText = t("runner.autopilotAnswer", { answer: part.answer });
        const blocks = buildQuestionBlocks({
          question: part.question,
          projectName,
          messageId,
          selectedAnswer: answerText,
          isSubmitted: true,
        });
        try {
          await client.chat.postMessage({
            channel: channelId,
            blocks,
            text: answerText,
            thread_ts: threadTs,
          });
        } catch (error) {
          log.error("Failed to post autopilot answer to Slack", error);
        }
        // Slack API 속도 제한 방지: 메시지 사이에 200ms 딜레이
        if (i < parts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // 리액션은 유지(⚙️)하고 상태 메시지만 갱신 — markCompleted를 쓰면
      // "✅ 완료" 후 즉시 새 작업이 시작되어 사용자에게 혼란을 줌
      await tracker.markAutopilotContinue();

      const currentSessionId = runner.currentSessionId;
      unregisterRunner(threadTs, runner);
      runner.kill();

      // Slack 전송 중 프로세스가 예상치 못하게 종료된 경우 resume 방지
      if (processExitedEarly) {
        log.warn("Process exited during autopilot askUser handling, aborting resume", { projectName });
        return;
      }

      if (currentSessionId) {
        try {
          setupClaudeRunner({
            client,
            channelId,
            threadTs,
            directory,
            projectName,
            prompt: combinedPrompt,
            sessionId: currentSessionId,
            autopilot: true,
          });
        } catch (error) {
          log.error("Autopilot: failed to resume", { projectName, error });
          await postThreadMessage(client, channelId, t("runner.autopilotResumeFailed"), threadTs);
          await tracker.markError(t("runner.autopilotResumeFailed"));
        }
      } else {
        log.error("Autopilot: no sessionId available for resume", { projectName });
        await postThreadMessage(client, channelId, t("runner.autopilotNoSession"), threadTs);
        await tracker.markError(t("runner.autopilotNoSession"));
      }
    } else {
      // ── 일반 모드: Slack에 질문 전송 후 사용자 응답 대기 ──

      // 복수 질문인 경우 pending batch 초기화 (순차 표시용)
      if (questions.length > 1) {
        initPendingBatch(threadTs, questions, projectName, channelId);
      }

      // 질문 데이터를 payload store에 저장 (Slack action.value 크기 제한 대응)
      setPayload(`q:${messageId}`, {
        questionText: firstQuestion.question,
        header: firstQuestion.header,
        optionLabels: firstQuestion.options.map(o => o.label),
      });

      // 첫 번째 질문이 multiSelect인 경우 상태 초기화
      if (firstQuestion?.multiSelect) {
        initState({
          projectName,
          messageId,
          options: firstQuestion.options,
          questionText: firstQuestion.question,
          header: firstQuestion.header,
        });
      }

      const blocks = buildQuestionBlocks({
        question: questions[0],
        projectName,
        messageId,
      });

      try {
        await client.chat.postMessage({
          channel: channelId,
          blocks,
          text: t("runner.questionArrived"),
          thread_ts: threadTs,
        });

        await tracker.markAskUser();

        log.info("Killing Claude process after AskUserQuestion sent to Slack");
        unregisterRunner(threadTs, runner);
        runner.kill();
      } catch (error) {
        log.error("Failed to send question to Slack", error);
        unregisterRunner(threadTs, runner);
        runner.kill();
      }
    }
  }, "askUser"));

  // 작업 완료 처리
  runner.on("result", safeAsync(async (event: ResultEvent) => {
    refreshActivity(threadTs, runner);
    resultReceived = true;
    resultPromise = (async () => {
      await textBuffer.flush();
      log.info("Task completed", { projectName, costUsd: event.costUsd });
      if (!completionHandled) {
        completionHandled = true;
        await tracker.markCompleted();
      }
    })();
    await resultPromise;

    // result 이벤트 후 프로세스가 확실히 종료되도록 명시적으로 kill 호출
    // (result 이벤트는 Claude가 작업을 완료했음을 의미하므로 안전하게 종료 가능)
    // kill()은 exit 이벤트를 발생시켜 cleanup(unregisterRunner 등)이 수행됨
    log.info("Killing Claude process after result received", { projectName });
    runner.kill();
  }, "result"));

  runner.on("error", safeAsync(async (error) => {
    await textBuffer.flush();
    unregisterRunner(threadTs, runner);
    errorHandled = true;

    // ENOENT = claude 명령이 PATH에 없음 → 친절한 안내 메시지
    const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";
    const userMessage = isNotFound
      ? t("runner.claudeNotFound")
      : t("runner.errorOccurred", { error: error.message });

    await postThreadMessage(client, channelId, userMessage, threadTs);
    await tracker.markError(userMessage);
  }, "error"));

  runner.on("exit", safeAsync(async (code) => {
    try {
      // result 핸들러가 진행 중이면 완료될 때까지 대기 (레이스 컨디션 방지)
      if (resultPromise) {
        await resultPromise;
      }
      await textBuffer.flush();
      unregisterRunner(threadTs, runner);
      // null = kill()로 종료 (autopilot resume, askUser 대기 등) → 무시
      if (code === null) return;
      // error 이벤트로 이미 알림 처리된 경우 중복 메시지 방지
      if (errorHandled) return;

      // askUser/exitPlanMode 핸들러가 비동기 작업 중일 때 프로세스가 예상치 못하게 종료된 경우
      // → processExitedEarly 플래그로 핸들러에 알리고, 에러 처리는 여기서 수행
      if (handlerTakeover) {
        processExitedEarly = true;
        const stderr = runner.stderrOutput;
        if (stderr) {
          log.error("Claude process stderr (during handler takeover)", { code, stderr: stderr.slice(-1000), threadTs, projectName });
        } else {
          log.warn("Process exited while askUser/exitPlanMode handler in progress", { code, projectName });
        }
        const errorMsg = t("runner.exitError", { code: String(code) });
        await postThreadMessage(client, channelId, errorMsg, threadTs);
        await tracker.markError(errorMsg);
        return;
      }

      // 정상 종료 + result 이벤트 수신 완료 → 무시
      if (code === 0 && resultReceived) return;
      // 정상 종료이나 result 이벤트 없음 → fallback 완료 처리
      if (code === 0 && !resultReceived) {
        log.warn("Claude exited normally but no result event", { projectName });
        if (!completionHandled) {
          completionHandled = true;
          await tracker.markCompleted();
        }
        return;
      }
      // 비정상 종료 → Slack 알림 + tracker 에러 표시 (stderr는 로그에만 기록)
      const stderr = runner.stderrOutput;
      if (stderr) {
        log.error("Claude process exited with error", { code, projectName, stderr: stderr.slice(-1000), threadTs });
      } else {
        log.warn("Claude process exited with error", { code, projectName });
      }
      const errorMsg = t("runner.exitError", { code: String(code) });
      await postThreadMessage(client, channelId, errorMsg, threadTs);
      await tracker.markError(errorMsg);
    } finally {
      tracker.dispose();
    }
  }, "exit"));
}
