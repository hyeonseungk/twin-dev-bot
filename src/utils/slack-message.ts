import type { WebClient } from "@slack/web-api";
import { buildQuestionBlocks } from "../slack/question-blocks.js";
import { createLogger } from "../core/logger.js";
import { t } from "../i18n/index.js";
import type { Question } from "../types/conversation.js";
import { getState } from "../stores/multi-select-state.js";
import { withRetry } from "./slack-rate-limit.js";

const log = createLogger("slack-message");

/**
 * Slack 메시지 텍스트 최대 길이.
 * Slack은 40,000자에서 메시지를 잘라내므로 약간의 여유를 두고 39,000자로 설정.
 */
export const SLACK_MAX_TEXT_LENGTH = 39_000;

/**
 * 텍스트에서 열린(닫히지 않은) 코드 펜스가 있는지 확인.
 * 열린 코드 펜스가 있으면 해당 펜스의 언어 식별자를 반환, 없으면 null.
 */
export function getUnclosedCodeFence(text: string): string | null {
  const fenceRegex = /^[ \t]*```(\S*)/gm;
  let isOpen = false;
  let lang = "";
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (!isOpen) {
      isOpen = true;
      lang = match[1] || "";
    } else {
      isOpen = false;
      lang = "";
    }
  }

  return isOpen ? lang : null;
}

/**
 * 분할로 깨진 코드 블록을 수정.
 * 열린 코드 블록이 있는 청크에 닫는 펜스를 추가하고,
 * 다음 청크에 여는 펜스를 추가.
 */
function repairCodeBlocks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [];
  let pendingOpen = "";

  for (let i = 0; i < chunks.length; i++) {
    let chunk = pendingOpen + chunks[i];
    pendingOpen = "";

    if (i < chunks.length - 1) {
      const lang = getUnclosedCodeFence(chunk);
      if (lang !== null) {
        chunk += "\n```";
        pendingOpen = "```" + lang + "\n";
      }
    }

    result.push(chunk);
  }

  return result;
}

/**
 * 긴 텍스트를 Slack 메시지 길이 제한에 맞게 분할.
 * 가능하면 단락 경계(\n\n), 줄바꿈(\n) 순으로 자연스러운 위치에서 분할.
 * 코드 블록(```)이 분할로 깨지면 자동으로 닫고 다음 청크에서 다시 열어줌.
 */
export function splitText(text: string, maxLength: number = SLACK_MAX_TEXT_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 단락 경계(\n\n)에서 분할 시도
    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex <= 0) {
      // 줄바꿈(\n)에서 분할 시도
      splitIndex = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitIndex <= 0) {
      // 자연스러운 분할 지점이 없으면 강제 분할
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n+/, "");
  }

  return repairCodeBlocks(chunks);
}

export type PostMessageResult =
  | { success: true; ts: string | undefined }
  | { success: false; error: unknown };

/**
 * 스레드에 메시지 전송.
 * Slack 메시지 길이 제한(40,000자)을 초과하면 자동으로 분할 전송.
 */
export async function postThreadMessage(
  client: WebClient,
  channelId: string,
  text: string,
  threadTs: string
): Promise<PostMessageResult> {
  if (!text) {
    log.warn("Skipping empty message", { channelId, threadTs });
    return { success: true, ts: undefined };
  }
  try {
    const chunks = splitText(text);
    let lastTs: string | undefined;

    for (const chunk of chunks) {
      const result = await withRetry(() =>
        client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs,
        })
      );
      lastTs = result.ts;
    }

    return { success: true, ts: lastTs! };
  } catch (error) {
    log.error("Failed to post thread message", { error, channelId, threadTs });
    return { success: false, error };
  }
}

/**
 * 채널에 메시지 전송 (스레드 없음)
 */
export async function postChannelMessage(
  client: WebClient,
  channelId: string,
  text: string
): Promise<PostMessageResult> {
  try {
    const result = await withRetry(() =>
      client.chat.postMessage({
        channel: channelId,
        text,
      })
    );
    return { success: true, ts: result.ts! };
  } catch (error) {
    log.error("Failed to post channel message", error);
    return { success: false, error };
  }
}

interface UpdateSlackMessageOptions {
  client: WebClient;
  channelId: string;
  ts: string;
  projectName: string;
  messageId: string;
  question: Question;
  /** 선택된 답변 (완료 시) */
  selectedAnswer?: string;
  isSubmitted: boolean;
}

/**
 * Slack 메시지 업데이트 (버튼 클릭 후 상태 반영)
 */
export async function updateSlackMessage(options: UpdateSlackMessageOptions): Promise<void> {
  const {
    client,
    channelId,
    ts,
    projectName,
    messageId,
    question,
    selectedAnswer,
    isSubmitted,
  } = options;

  const blocks = buildQuestionBlocks({
    question,
    projectName,
    messageId,
    selectedAnswer,
    isSubmitted,
  });

  try {
    await withRetry(() =>
      client.chat.update({
        channel: channelId,
        ts,
        text: isSubmitted ? t("slack.answered") : t("slack.question"),
        blocks,
      })
    );
  } catch (error) {
    log.error("Failed to update message", error);
  }
}

interface UpdateMultiSelectOptions {
  client: WebClient;
  channelId: string;
  ts: string;
  projectName: string;
  messageId: string;
  selectedOptionIndexes: number[];
}

/**
 * 복수 선택 토글 후 Slack 메시지 업데이트
 * multi-select-state에서 옵션 정보를 가져와서 blocks 재생성
 */
export async function updateSlackMessageWithMultiSelect(
  options: UpdateMultiSelectOptions
): Promise<void> {
  const {
    client,
    channelId,
    ts,
    projectName,
    messageId,
    selectedOptionIndexes,
  } = options;

  // 상태에서 옵션 정보 가져오기
  const state = getState(projectName, messageId);
  if (!state) {
    log.error("Multi-select state not found", { projectName, messageId });
    return;
  }

  const question: Question = {
    question: state.questionText,
    header: state.header,
    options: state.options,
    multiSelect: true,
  };

  const blocks = buildQuestionBlocks({
    question,
    projectName,
    messageId,
    isSubmitted: false,
    selectedOptionIndexes,
  });

  try {
    await withRetry(() =>
      client.chat.update({
        channel: channelId,
        ts,
        text: t("slack.question"),
        blocks,
      })
    );
  } catch (error) {
    log.error("Failed to update multi-select message", error);
  }
}

/**
 * 메시지에 이모지 리액션 추가
 * already_reacted 에러는 무시
 */
export async function addReaction(
  client: WebClient,
  channelId: string,
  ts: string,
  emoji: string
): Promise<void> {
  try {
    await withRetry(() =>
      client.reactions.add({ channel: channelId, timestamp: ts, name: emoji })
    );
  } catch (error: unknown) {
    const slackError = error as { data?: { error?: string } };
    if (slackError.data?.error === "already_reacted") return;
    log.error("Failed to add reaction", { error, channelId, ts, emoji });
  }
}

/**
 * 메시지에서 이모지 리액션 제거
 * no_reaction 에러는 무시
 */
export async function removeReaction(
  client: WebClient,
  channelId: string,
  ts: string,
  emoji: string
): Promise<void> {
  try {
    await withRetry(() =>
      client.reactions.remove({ channel: channelId, timestamp: ts, name: emoji })
    );
  } catch (error: unknown) {
    const slackError = error as { data?: { error?: string } };
    if (slackError.data?.error === "no_reaction") return;
    log.error("Failed to remove reaction", { error, channelId, ts, emoji });
  }
}
