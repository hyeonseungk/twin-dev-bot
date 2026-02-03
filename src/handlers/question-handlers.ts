import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { sessionManager } from "../claude/session-manager.js";
import { createLogger } from "../core/logger.js";
import { updateSlackMessage, updateSlackMessageWithMultiSelect, postThreadMessage } from "../utils/slack-message.js";
import { setupClaudeRunner, type SetupClaudeRunnerOptions } from "./claude-runner-setup.js";
import { toggleOption, getSelectedOptions, clearState, initState, getState } from "../stores/multi-select-state.js";
import { isRunnerActive, killActiveRunner } from "../claude/active-runners.js";
import { t } from "../i18n/index.js";
import { config } from "../core/config.js";
import {
  hasPendingBatch,
  recordAnswerAndAdvance,
  buildCombinedAnswer,
  clearPendingBatch,
} from "../stores/pending-questions.js";
import { buildQuestionBlocks } from "../slack/question-blocks.js";
import type {
  SelectedOptionValue,
  TextInputButtonValue,
  TextInputModalMetadata,
  ToggleOptionValue,
  SubmitMultiSelectValue,
  AutopilotInterruptValue,
} from "../types/index.js";
import type { ClaudeSession } from "../claude/session-manager.js";
import { getWorkspace } from "../stores/workspace-store.js";
import { getPayload, removePayload, setPayload } from "../stores/action-payload-store.js";
import type { StoredQuestionPayload } from "../types/index.js";
import type { SlackFileInfo } from "../types/index.js";
import { downloadSlackFiles, type DownloadedFile } from "../utils/slack-file-downloader.js";

const log = createLogger("question-handlers");

// ─────────────────────────────────────────────────────────────────────────
// Race condition 방지: 동일 스레드에서 동시 resumeClaudeWithAnswer 호출 방지
// ─────────────────────────────────────────────────────────────────────────
const pendingResumes = new Set<string>();

interface InterruptPayload {
  text: string;
  files?: SlackFileInfo[];
}

interface SessionLookupResult {
  session: ClaudeSession;
  threadTs: string;
}

/**
 * 액션의 메시지에서 threadTs를 추출하고 세션을 조회하는 공통 헬퍼
 */
function resolveSessionFromAction(
  message: unknown,
  projectName: string
): SessionLookupResult | null {
  const threadTs = (message as Record<string, unknown>)?.thread_ts as string | undefined;
  if (!threadTs) {
    log.error("Thread ts not found in message", { projectName });
    return null;
  }

  const session = sessionManager.getByThread(threadTs);
  if (!session) {
    log.error("Session not found", { projectName, threadTs });
    return null;
  }

  return { session, threadTs };
}

/**
 * 세션을 찾지 못했을 때 사용자에게 ephemeral 메시지로 안내
 */
async function postSessionExpiredNotice(
  client: WebClient,
  channelId: string,
  userId: string,
  threadTs?: string,
  projectName?: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: projectName ? t("session.expired", { projectName }) : t("session.expiredUnknown"),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    log.error("Failed to send session expired notice", error);
  }
}

async function postActionErrorNotice(
  client: WebClient,
  channelId: string,
  userId: string,
  threadTs?: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: t("error.actionFailed"),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (ephemeralError) {
    log.error("Failed to send action error notice", ephemeralError);
  }
}

function buildInterruptPayloadKey(threadTs: string, userMessageTs?: string): string {
  return userMessageTs ? `interrupt:${threadTs}:${userMessageTs}` : `interrupt:${threadTs}`;
}

async function postInterruptPayloadMissingNotice(
  client: WebClient,
  channelId: string,
  userId: string,
  threadTs?: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: t("interrupt.payloadExpired"),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    log.error("Failed to send interrupt payload missing notice", error);
  }
}

async function downloadInterruptFiles(
  client: WebClient,
  channelId: string,
  threadTs: string,
  slackFiles: SlackFileInfo[]
): Promise<DownloadedFile[]> {
  if (slackFiles.length === 0) return [];

  try {
    const downloadResult = await downloadSlackFiles(slackFiles, config.slack.botToken);
    const downloadedFiles = downloadResult.success;

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
        channelId,
        `Some files could not be processed:\n${warnings.join("\n")}`,
        threadTs
      );
    }

    return downloadedFiles;
  } catch (error) {
    log.error("Failed to download interrupt files", error);
    await postThreadMessage(
      client,
      channelId,
      `\u274C Failed to download attached files: ${error instanceof Error ? error.message : String(error)}`,
      threadTs
    );
    return [];
  }
}

interface ResumeClaudeOptions {
  client: SetupClaudeRunnerOptions["client"];
  session: ClaudeSession;
  channelId: string;
  userId: string;
  messageTs: string;
  projectName: string;
  messageId: string;
  answerText: string;
  questionText: string;
  header?: string;
  multiSelect?: boolean;
}

/**
 * 사용자 응답 후 Claude를 resume하는 공통 흐름:
 * 1. Slack 메시지 업데이트 (완료 표시)
 * 2. 대기 중인 복수 질문이 있으면 다음 질문 전송 (Claude resume 안 함)
 * 3. 모든 질문에 답변 완료되면 조합된 답변으로 Claude resume
 * 4. 대기 질문이 없으면 단일 답변으로 Claude resume
 */
async function resumeClaudeWithAnswer(options: ResumeClaudeOptions): Promise<void> {
  const { client, session, channelId, userId, messageTs, projectName, messageId, answerText, questionText, header, multiSelect } = options;

  const threadTs = session.slackThreadTs;

  // 이미 러너가 실행 중이면 ephemeral 메시지로 안내 (버튼 더블 클릭 방지)
  if (isRunnerActive(threadTs)) {
    log.warn("Runner already active, ignoring duplicate answer", { projectName, threadTs });
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: t("error.alreadyProcessing"),
        thread_ts: threadTs,
      });
    } catch (error) {
      log.error("Failed to send already-processing notice", error);
    }
    return;
  }

  // Race condition 방지: 이미 resume 진행 중이면 무시 (더블 클릭 방지)
  if (pendingResumes.has(threadTs)) {
    log.warn("Resume already in progress, ignoring duplicate answer", { projectName, threadTs });
    return;
  }

  pendingResumes.add(threadTs);
  try {
    // 1. 현재 Slack 메시지를 답변 완료로 업데이트
    const displayQuestionText = questionText || "(Original question expired)";
    await updateSlackMessage({
      client,
      channelId,
      ts: messageTs,
      projectName,
      messageId,
      question: { question: displayQuestionText, header, options: [], multiSelect },
      selectedAnswer: answerText,
      isSubmitted: true,
    });

    // 2. 대기 중인 복수 질문 배치 확인
    if (hasPendingBatch(threadTs)) {
      const result = recordAnswerAndAdvance(threadTs, answerText);

      if (result && !result.done) {
        // 아직 남은 질문이 있음 — 다음 질문을 새 Slack 메시지로 전송
        const nextQuestion = result.nextQuestion!;
        const newMessageId = `ask-${threadTs}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 질문 데이터를 payload store에 저장
        setPayload(`q:${newMessageId}`, {
          questionText: nextQuestion.question,
          header: nextQuestion.header,
          optionLabels: nextQuestion.options.map((o: { label: string }) => o.label),
        });

        // 다음 질문이 multiSelect이면 상태 초기화
        if (nextQuestion.multiSelect) {
          initState({
            projectName,
            messageId: newMessageId,
            options: nextQuestion.options,
            questionText: nextQuestion.question,
            header: nextQuestion.header,
          });
        }

        const blocks = buildQuestionBlocks({
          question: nextQuestion,
          projectName,
          messageId: newMessageId,
        });

        await client.chat.postMessage({
          channel: channelId,
          blocks,
          text: t("runner.questionArrived"),
          thread_ts: threadTs,
        });

        log.info("Posted next pending question", {
          projectName,
          threadTs,
          questionIndex: result.batch.currentIndex,
          totalQuestions: result.batch.questions.length,
        });

        // Claude resume 하지 않음 — 다음 답변 대기
        return;
      }

      if (result && result.done) {
        // 모든 질문에 답변 완료 — 조합된 답변으로 Claude resume
        const combinedAnswer = buildCombinedAnswer(threadTs);
        clearPendingBatch(threadTs);

        if (combinedAnswer) {
          log.info("All pending questions answered, resuming Claude", {
            projectName,
            threadTs,
            answerPreview: combinedAnswer.slice(0, 100),
          });

          setupClaudeRunner({
            client,
            channelId: session.slackChannelId,
            threadTs,
            directory: session.directory,
            projectName: session.projectName,
            prompt: combinedAnswer,
            sessionId: session.sessionId,
            autopilot: session.autopilot,
          });
          return;
        }
      }

      // fallback: result가 null이면 배치 정리 후 일반 흐름
      clearPendingBatch(threadTs);
    }

    // 3. 대기 질문 없음 — 단일 답변으로 Claude resume (기존 동작)
    setupClaudeRunner({
      client,
      channelId: session.slackChannelId,
      threadTs,
      directory: session.directory,
      projectName: session.projectName,
      prompt: answerText,
      sessionId: session.sessionId,
      autopilot: session.autopilot,
    });
  } catch (error) {
    log.error("Failed to resume Claude with answer", error);
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: t("error.resumeFailed"),
        thread_ts: threadTs,
      });
    } catch (notifyError) {
      log.error("Failed to send resume error notice", notifyError);
    }
  } finally {
    pendingResumes.delete(threadTs);
  }
}

export function registerQuestionHandlers(app: App): void {
  log.info("Registering question handlers");

  // 단일 선택 옵션 핸들러 - 버튼 클릭 시 바로 Claude에 전달
  // ─────────────────────────────────────────────────────────────────────────
  // AskUserQuestion 응답 흐름의 마지막 단계:
  // 1. 사용자가 Slack에서 버튼 클릭
  // 2. 선택된 옵션으로 Slack 메시지 업데이트 (완료 표시)
  // 3. setupClaudeRunner()를 session.sessionId와 함께 호출
  //    → --resume 옵션으로 기존 세션 이어서 실행
  //    → 선택한 답변이 prompt로 전달됨
  // ─────────────────────────────────────────────────────────────────────────
  app.action<BlockAction<ButtonAction>>(
    /^select_option_\d+_\d+$/,
    async ({ ack, body, client, action }) => {
      await ack();
      try {
        log.info("Button clicked", { action_id: action.action_id });

        const message = body.message;
        if (!action.value) return;

        let selected: SelectedOptionValue;
        try {
          selected = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse select_option value", { value: action.value?.slice(0, 100) });
          return;
        }

        const { projectName, messageId } = selected;

        const channelId = body.channel?.id;
        const messageTs = (message as Record<string, unknown> | undefined)?.ts as string | undefined;
        if (!channelId || !messageTs) {
          log.error("Missing channel or message ts in select_option action", { projectName, hasChannel: !!body.channel, hasMessage: !!message });
          return;
        }

        const resolved = resolveSessionFromAction(message, projectName);
        if (!resolved) {
          const threadTs = (message as Record<string, unknown>)?.thread_ts as string | undefined;
          await postSessionExpiredNotice(client, channelId, body.user.id, threadTs, projectName);
          return;
        }
        const { session } = resolved;

        // 질문 데이터를 payload store에서 조회
        const questionPayload = getPayload<StoredQuestionPayload>(`q:${messageId}`);

        await resumeClaudeWithAnswer({
          client,
          session,
          channelId,
          userId: body.user.id,
          messageTs,
          projectName,
          messageId,
          answerText: selected.label,
          questionText: questionPayload?.questionText ?? "",
          header: questionPayload?.header,
        });

        log.info("Answer sent to Claude", {
          projectName,
          threadTs: session.slackThreadTs,
          answer: selected.label,
        });
      } catch (error) {
        log.error("Error handling select_option action", error);
        const threadTs = (body.message as Record<string, unknown> | undefined)?.thread_ts as string | undefined;
        await postActionErrorNotice(client, body.channel?.id ?? "", body.user.id, threadTs);
      }
    }
  );

  // 직접 입력 버튼 핸들러
  app.action<BlockAction<ButtonAction>>(
    /^text_input_\d+$/,
    async ({ ack, body, client, action }) => {
      await ack();
      try {
        const message = body.message;
        if (!action.value) return;

        let textInputValue: TextInputButtonValue;
        try {
          textInputValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse text_input value", { value: action.value?.slice(0, 100) });
          return;
        }

        const { projectName, messageId } = textInputValue;

        const channelId = body.channel?.id;
        const messageTs = (message as Record<string, unknown> | undefined)?.ts as string | undefined;
        if (!channelId || !messageTs) {
          log.error("Missing channel or message ts in text_input action", { projectName, hasChannel: !!body.channel, hasMessage: !!message });
          return;
        }

        const resolved = resolveSessionFromAction(message, projectName);
        if (!resolved) {
          const threadTs = (message as Record<string, unknown>)?.thread_ts as string | undefined;
          await postSessionExpiredNotice(client, channelId, body.user.id, threadTs);
          return;
        }
        const { session, threadTs } = resolved;

        const questionIndex = textInputValue.questionIndex;

        // questionText, header는 action-payload-store에 저장되어 있으므로
        // modal metadata에 포함하지 않음 (private_metadata ~3,000바이트 제한 대응)
        const metadata: TextInputModalMetadata = {
          requestId: `${projectName}:${messageId}`,
          questionIndex,
          channelId,
          messageTs,
          threadTs,
        };

        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal",
            callback_id: "text_input_modal",
            private_metadata: JSON.stringify(metadata),
            title: { type: "plain_text", text: t("modal.title") },
            submit: { type: "plain_text", text: t("modal.submit") },
            close: { type: "plain_text", text: t("modal.cancel") },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: t("modal.prompt"),
                },
              },
              {
                type: "input",
                block_id: "answer_block",
                label: { type: "plain_text", text: t("modal.label") },
                element: {
                  type: "plain_text_input",
                  action_id: "answer_input",
                  multiline: true,
                  placeholder: { type: "plain_text", text: t("modal.placeholder") },
                },
              },
            ],
          },
        });
        log.debug("Modal opened", { question: questionIndex + 1 });
      } catch (error) {
        log.error("Error handling text_input action", error);
        const threadTs = (body.message as Record<string, unknown> | undefined)?.thread_ts as string | undefined;
        await postActionErrorNotice(client, body.channel?.id ?? "", body.user.id, threadTs);
      }
    }
  );

  // 모달 제출 핸들러 - 직접 입력 시 Claude에 바로 전달
  app.view("text_input_modal", async ({ ack, view, client, body }) => {
    await ack();
    let metadata: TextInputModalMetadata | undefined;
    try {
      try {
        metadata = JSON.parse(view.private_metadata);
      } catch {
        log.error("Failed to parse modal metadata", { metadata: view.private_metadata?.slice(0, 100) });
        return;
      }

      if (!metadata) return;
      const { requestId, channelId, messageTs, threadTs } = metadata;

      // requestId에서 projectName:messageId 파싱 (messageId에 ':'가 포함될 수 있으므로 첫 번째 ':'만 기준으로 분리)
      const colonIndex = requestId.indexOf(":");
      if (colonIndex === -1) {
        log.error("Invalid requestId format: missing ':'", { requestId });
        return;
      }
      const projectName = requestId.substring(0, colonIndex);
      const messageId = requestId.substring(colonIndex + 1);

      const answerText = view.state.values.answer_block.answer_input.value || "";

      if (!answerText.trim()) {
        log.debug("Empty answer - ignoring");
        return;
      }

      // threadTs로 세션 조회
      const session = sessionManager.getByThread(threadTs);
      if (!session) {
        log.error("Session not found", { projectName, threadTs });
        await postSessionExpiredNotice(client, channelId, body.user.id, threadTs, projectName);
        return;
      }

      const trimmedAnswer = answerText.trim();

      // multiSelect 질문에서 "직접 입력"으로 답변한 경우 상태 정리
      clearState(projectName, messageId);

      // 질문 데이터를 payload store에서 조회
      const questionPayload = getPayload<StoredQuestionPayload>(`q:${messageId}`);

      await resumeClaudeWithAnswer({
        client,
        session,
        channelId,
        userId: body.user.id,
        messageTs,
        projectName,
        messageId,
        answerText: trimmedAnswer,
        questionText: questionPayload?.questionText ?? "",
        header: questionPayload?.header,
      });

      log.info("Custom answer sent to Claude", {
        projectName,
        threadTs: session.slackThreadTs,
        preview: trimmedAnswer.slice(0, 50),
      });
    } catch (error) {
      log.error("Error handling text_input_modal submission", error);
      if (metadata) {
        await postActionErrorNotice(client, metadata.channelId, body.user.id, metadata.threadTs);
      }
    }
  });

  // 복수 선택 토글 핸들러 - 옵션 선택/해제
  // Note: ack() is called immediately to meet Slack's 3-second requirement.
  // Visual feedback delay is due to Slack's message update latency and cannot be further optimized at the application level.
  app.action<BlockAction<ButtonAction>>(
    /^toggle_option_\d+_\d+$/,
    async ({ ack, body, client, action }) => {
      await ack();
      try {
        log.info("Toggle button clicked", { action_id: action.action_id });

        const message = body.message;
        if (!action.value) return;

        let toggleValue: ToggleOptionValue;
        try {
          toggleValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse toggle_option value", { value: action.value?.slice(0, 100) });
          return;
        }

        const { projectName, messageId } = toggleValue;

        const channelId = body.channel?.id;
        const messageTs = (message as Record<string, unknown> | undefined)?.ts as string | undefined;
        if (!channelId || !messageTs) {
          log.error("Missing channel or message ts in toggle_option action", { projectName, hasChannel: !!body.channel, hasMessage: !!message });
          return;
        }

        const resolved = resolveSessionFromAction(message, projectName);
        if (!resolved) {
          const threadTs = (message as Record<string, unknown>)?.thread_ts as string | undefined;
          await postSessionExpiredNotice(client, channelId, body.user.id, threadTs, projectName);
          return;
        }

        // 상태 토글
        toggleOption(projectName, messageId, toggleValue.optionIndex);
        const selectedIndexes = getSelectedOptions(projectName, messageId);

        // Slack 메시지 업데이트 (선택 상태 반영)
        await updateSlackMessageWithMultiSelect({
          client,
          channelId,
          ts: messageTs,
          projectName,
          messageId,
          selectedOptionIndexes: selectedIndexes,
        });

        log.debug("Toggle state updated", {
          projectName,
          messageId,
          optionIndex: toggleValue.optionIndex,
          selectedIndexes,
        });
      } catch (error) {
        log.error("Error handling toggle_option action", error);
        const threadTs = (body.message as Record<string, unknown> | undefined)?.thread_ts as string | undefined;
        await postActionErrorNotice(client, body.channel?.id ?? "", body.user.id, threadTs);
      }
    }
  );

  // 복수 선택 완료 핸들러 - "선택 완료" 버튼 클릭 시 Claude에 전달
  // ─────────────────────────────────────────────────────────────────────────
  // multiSelect=true인 경우의 응답 흐름:
  // 1. 사용자가 여러 옵션을 토글로 선택/해제 (toggle_option 핸들러)
  // 2. "선택 완료" 버튼 클릭 시 이 핸들러 실행
  // 3. 선택된 옵션들을 쉼표로 연결하여 답변 생성
  // 4. setupClaudeRunner()를 session.sessionId와 함께 호출
  //    → --resume 옵션으로 기존 세션 이어서 실행
  // ─────────────────────────────────────────────────────────────────────────
  app.action<BlockAction<ButtonAction>>(
    /^submit_multi_select_\d+$/,
    async ({ ack, body, client, action }) => {
      await ack();
      try {
        log.info("Submit multi-select clicked", { action_id: action.action_id });

        const message = body.message;
        if (!action.value) return;

        let submitValue: SubmitMultiSelectValue;
        try {
          submitValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse submit_multi_select value", { value: action.value?.slice(0, 100) });
          return;
        }

        const { projectName, messageId } = submitValue;

        const channelId = body.channel?.id;
        const messageTs = (message as Record<string, unknown> | undefined)?.ts as string | undefined;
        if (!channelId || !messageTs) {
          log.error("Missing channel or message ts in submit_multi_select action", { projectName, hasChannel: !!body.channel, hasMessage: !!message });
          return;
        }

        const resolved = resolveSessionFromAction(message, projectName);
        if (!resolved) {
          const threadTs = (message as Record<string, unknown>)?.thread_ts as string | undefined;
          await postSessionExpiredNotice(client, channelId, body.user.id, threadTs, projectName);
          return;
        }
        const { session } = resolved;

        // 선택된 옵션들 가져오기
        const selectedIndexes = getSelectedOptions(projectName, messageId);

        if (selectedIndexes.length === 0) {
          log.warn("No options selected", { projectName, messageId });
          const threadTs = (message as Record<string, unknown>)?.thread_ts as string | undefined;
          try {
            await client.chat.postEphemeral({
              channel: channelId,
              user: body.user.id,
              text: t("multiSelect.noneSelected"),
              ...(threadTs ? { thread_ts: threadTs } : {}),
            });
          } catch (error) {
            log.error("Failed to send no-selection notice", error);
          }
          return;
        }

        // 질문 데이터를 payload store에서 조회
        const questionPayload = getPayload<StoredQuestionPayload>(`q:${messageId}`);

        // payload가 만료된 경우 multi-select-state에서 옵션 라벨을 fallback으로 사용
        const msState = !questionPayload ? getState(projectName, messageId) : null;
        let optionLabels = questionPayload?.optionLabels ?? [];
        if (optionLabels.length === 0 && msState) {
          optionLabels = msState.options.map(o => o.label);
          log.warn("Payload expired, using multi-select-state as fallback for option labels", { projectName, messageId });
        }

        // 선택된 라벨들 조합
        const selectedLabels = selectedIndexes
          .map(i => optionLabels[i])
          .filter(Boolean);
        const answerText = selectedLabels.join(", ");

        // 상태 정리
        clearState(projectName, messageId);

        await resumeClaudeWithAnswer({
          client,
          session,
          channelId,
          userId: body.user.id,
          messageTs,
          projectName,
          messageId,
          answerText,
          questionText: questionPayload?.questionText ?? msState?.questionText ?? "",
          header: questionPayload?.header ?? msState?.header,
          multiSelect: true,
        });

        log.info("Multi-select answer sent to Claude", {
          projectName,
          threadTs: session.slackThreadTs,
          selectedLabels,
        });
      } catch (error) {
        log.error("Error handling submit_multi_select action", error);
        const threadTs = (body.message as Record<string, unknown> | undefined)?.thread_ts as string | undefined;
        await postActionErrorNotice(client, body.channel?.id ?? "", body.user.id, threadTs);
      }
    }
  );

  // 일반 모드 개입 확인 - "예" 핸들러
  // 이전 작업을 중단하고 사용자 메시지로 새 작업 시작
  app.action<BlockAction<ButtonAction>>(
    "normal_interrupt_yes",
    async ({ ack, body, client, action }) => {
      await ack();
      let interruptValue: AutopilotInterruptValue | undefined;
      try {
        if (!action.value) return;

        try {
          interruptValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse normal_interrupt_yes value", { value: action.value?.slice(0, 100) });
          return;
        }

        if (!interruptValue) return;
        const { threadTs, channelId, projectName, userMessageTs } = interruptValue;

        log.info("Normal interrupt confirmed (yes)", { projectName, threadTs });

        // 실행 중인 러너 종료
        killActiveRunner(threadTs);

        // 확인 메시지 업데이트
        const messageTs = body.message?.ts;
        if (messageTs) {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: t("command.normalInterruptedYes"),
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: t("command.normalInterruptedYes") },
              },
            ],
          });
        }

        // 사용자 메시지로 새 작업 시작
        const session = sessionManager.getByThread(threadTs);
        const workspace = session ? undefined : getWorkspace(threadTs);
        if (!session && !workspace) {
          await postThreadMessage(client, channelId, t("session.notFound"), threadTs);
          return;
        }

        // userMessage + 첨부 파일을 payload store에서 조회
        const payloadKey = buildInterruptPayloadKey(threadTs, userMessageTs);
        const payload = getPayload<InterruptPayload | string>(payloadKey, true);
        const userMessage = typeof payload === "string" ? payload : payload?.text ?? "";
        const slackFiles = typeof payload === "string" ? [] : payload?.files ?? [];

        if (!userMessage.trim() && slackFiles.length === 0) {
          await postInterruptPayloadMissingNotice(client, channelId, body.user.id, threadTs);
          return;
        }

        const downloadedFiles = await downloadInterruptFiles(client, channelId, threadTs, slackFiles);
        const prompt = userMessage.trim() || (downloadedFiles.length > 0 ? "Please analyze the attached file(s)." : "");
        if (!prompt) {
          await postInterruptPayloadMissingNotice(client, channelId, body.user.id, threadTs);
          return;
        }

        if (session) {
          setupClaudeRunner({
            client,
            channelId: session.slackChannelId,
            threadTs: session.slackThreadTs,
            directory: session.directory,
            projectName: session.projectName,
            prompt,
            sessionId: session.sessionId,
            autopilot: session.autopilot,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          });
        } else if (workspace) {
          setupClaudeRunner({
            client,
            channelId: workspace.channelId,
            threadTs,
            directory: workspace.directory,
            projectName: workspace.projectName,
            prompt,
            autopilot: workspace.autopilot,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          });
        }
      } catch (error) {
        log.error("Error handling normal_interrupt_yes", error);
        await postActionErrorNotice(client, interruptValue?.channelId ?? body.channel?.id ?? "", body.user?.id ?? "", interruptValue?.threadTs);
      }
    }
  );

  // 일반 모드 개입 확인 - "아니오" 핸들러
  // 이전 작업을 계속 진행
  app.action<BlockAction<ButtonAction>>(
    "normal_interrupt_no",
    async ({ ack, body, client, action }) => {
      await ack();
      let interruptValue: AutopilotInterruptValue | undefined;
      try {
        if (!action.value) return;

        try {
          interruptValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse normal_interrupt_no value", { value: action.value?.slice(0, 100) });
          return;
        }

        if (!interruptValue) return;
        const { channelId, projectName, threadTs, userMessageTs } = interruptValue;

        // 사용하지 않는 userMessage 정리
        removePayload(buildInterruptPayloadKey(threadTs, userMessageTs));

        log.info("Normal interrupt declined (no)", { projectName, threadTs });

        // 확인 메시지를 계속 진행 안내로 업데이트
        const messageTs = body.message?.ts;
        if (messageTs) {
          // 러너가 아직 활성 상태인지 확인
          const message = isRunnerActive(threadTs)
            ? t("command.normalInterruptContinue")
            : t("interrupt.taskAlreadyCompleted");

          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: message,
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: message },
              },
            ],
          });
        }
      } catch (error) {
        log.error("Error handling normal_interrupt_no", error);
        await postActionErrorNotice(client, interruptValue?.channelId ?? body.channel?.id ?? "", body.user?.id ?? "", interruptValue?.threadTs);
      }
    }
  );

  // Autopilot 개입 확인 - "네" 핸들러
  // autopilot 모드 중단 후 사용자 메시지를 일반 모드로 실행
  app.action<BlockAction<ButtonAction>>(
    "autopilot_interrupt_yes",
    async ({ ack, body, client, action }) => {
      await ack();
      let interruptValue: AutopilotInterruptValue | undefined;
      try {
        if (!action.value) return;

        try {
          interruptValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse autopilot_interrupt_yes value", { value: action.value?.slice(0, 100) });
          return;
        }

        if (!interruptValue) return;
        const { threadTs, channelId, projectName, userMessageTs } = interruptValue;

        log.info("Autopilot interrupt confirmed (yes)", { projectName, threadTs });

        // 실행 중인 러너 종료
        killActiveRunner(threadTs);

        // 세션의 autopilot 플래그 해제
        sessionManager.setAutopilot(threadTs, false);

        // 확인 메시지 업데이트
        const messageTs = body.message?.ts;
        if (messageTs) {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: t("command.autopilotInterruptedYes"),
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: t("command.autopilotInterruptedYes") },
              },
            ],
          });
        }

        // 사용자 메시지를 일반 모드로 실행
        const session = sessionManager.getByThread(threadTs);
        const workspace = session ? undefined : getWorkspace(threadTs);
        if (!session && !workspace) {
          await postThreadMessage(client, channelId, t("session.notFound"), threadTs);
          return;
        }

        // userMessage + 첨부 파일을 payload store에서 조회
        const payloadKey = buildInterruptPayloadKey(threadTs, userMessageTs);
        const payload = getPayload<InterruptPayload | string>(payloadKey, true);
        const userMessage = typeof payload === "string" ? payload : payload?.text ?? "";
        const slackFiles = typeof payload === "string" ? [] : payload?.files ?? [];

        if (!userMessage.trim() && slackFiles.length === 0) {
          await postInterruptPayloadMissingNotice(client, channelId, body.user.id, threadTs);
          return;
        }

        const downloadedFiles = await downloadInterruptFiles(client, channelId, threadTs, slackFiles);
        const prompt = userMessage.trim() || (downloadedFiles.length > 0 ? "Please analyze the attached file(s)." : "");
        if (!prompt) {
          await postInterruptPayloadMissingNotice(client, channelId, body.user.id, threadTs);
          return;
        }

        if (session) {
          setupClaudeRunner({
            client,
            channelId: session.slackChannelId,
            threadTs: session.slackThreadTs,
            directory: session.directory,
            projectName: session.projectName,
            prompt,
            sessionId: session.sessionId,
            autopilot: false,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          });
        } else if (workspace) {
          setupClaudeRunner({
            client,
            channelId: workspace.channelId,
            threadTs,
            directory: workspace.directory,
            projectName: workspace.projectName,
            prompt,
            autopilot: false,
            files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          });
        }
      } catch (error) {
        log.error("Error handling autopilot_interrupt_yes", error);
        await postActionErrorNotice(client, interruptValue?.channelId ?? body.channel?.id ?? "", body.user?.id ?? "", interruptValue?.threadTs);
      }
    }
  );

  // Autopilot 개입 확인 - "아니요" 핸들러
  // autopilot 모드를 유지하고 확인 메시지만 업데이트
  app.action<BlockAction<ButtonAction>>(
    "autopilot_interrupt_no",
    async ({ ack, body, client, action }) => {
      await ack();
      let interruptValue: AutopilotInterruptValue | undefined;
      try {
        if (!action.value) return;

        try {
          interruptValue = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse autopilot_interrupt_no value", { value: action.value?.slice(0, 100) });
          return;
        }

        if (!interruptValue) return;
        const { channelId, projectName, threadTs, userMessageTs } = interruptValue;

        // 사용하지 않는 userMessage 정리
        removePayload(buildInterruptPayloadKey(threadTs, userMessageTs));

        log.info("Autopilot interrupt declined (no)", { projectName, threadTs });

        // 확인 메시지를 계속 진행 안내로 업데이트
        const messageTs = body.message?.ts;
        if (messageTs) {
          // 러너가 아직 활성 상태인지 확인
          const message = isRunnerActive(threadTs)
            ? t("command.autopilotContinue")
            : t("interrupt.taskAlreadyCompleted");

          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: message,
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: message },
              },
            ],
          });
        }
      } catch (error) {
        log.error("Error handling autopilot_interrupt_no", error);
        await postActionErrorNotice(client, interruptValue?.channelId ?? body.channel?.id ?? "", body.user?.id ?? "", interruptValue?.threadTs);
      }
    }
  );
}
