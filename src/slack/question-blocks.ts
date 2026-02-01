import type { KnownBlock, Button, ActionsBlock, SectionBlock, ContextBlock, DividerBlock, HeaderBlock } from "@slack/types";
import type {
  Question,
  SelectedOptionValue,
  TextInputButtonValue,
  ToggleOptionValue,
  SubmitMultiSelectValue,
} from "../types/index.js";
import { t } from "../i18n/index.js";

type SlackBlock = KnownBlock | ActionsBlock | SectionBlock | ContextBlock | DividerBlock | HeaderBlock;

const SLACK_BLOCK_LIMIT = 50;
const SLACK_BUTTON_TEXT_LIMIT = 75;

/** 버튼 텍스트가 Slack 제한(75자)을 초과하면 말줄임표(…)를 붙여 잘린 것을 표시 */
function truncateButtonText(text: string): string {
  if (text.length <= SLACK_BUTTON_TEXT_LIMIT) return text;
  return text.slice(0, SLACK_BUTTON_TEXT_LIMIT - 1) + "…";
}

interface BuildQuestionBlocksOptions {
  /** 렌더링할 질문 */
  question: Question;
  /** 프로젝트명 */
  projectName: string;
  /** 질문 메시지 ID */
  messageId: string;
  /** 선택된 답변 (완료 시) */
  selectedAnswer?: string;
  /** 완료 여부 */
  isSubmitted?: boolean;
  /** multiSelect 시 현재 선택된 옵션 인덱스 배열 */
  selectedOptionIndexes?: number[];
}

/**
 * AskUserQuestion을 Slack Block으로 변환
 * 단일 질문을 렌더링하고, 버튼 클릭 시 바로 Claude에 전달
 *
 * 주의: 버튼 value에는 짧은 필드만 포함.
 * questionText, header, optionLabels 등은 action-payload-store에 별도 저장되어
 * 핸들러에서 messageId로 조회함 (Slack action.value ~2,000바이트 제한 대응).
 */
export function buildQuestionBlocks(options: BuildQuestionBlocksOptions): SlackBlock[] {
  const {
    question,
    projectName,
    messageId,
    selectedAnswer,
    isSubmitted = false,
    selectedOptionIndexes = [],
  } = options;

  const blocks: SlackBlock[] = [];

  // 헤더
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: isSubmitted ? t("question.headerCompleted") : t("question.header"),
      emoji: true,
    },
  } as HeaderBlock);

  // 질문 제목
  if (question.header) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${question.header}*` },
    } as SectionBlock);
  }

  // 질문 내용
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: question.question },
  } as SectionBlock);

  blocks.push({ type: "divider" } as DividerBlock);

  if (isSubmitted && selectedAnswer) {
    // 완료 상태 - 체크 이모지와 선택된 답변 표시
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `✅ *${selectedAnswer}*` },
    } as SectionBlock);
  } else if (question.multiSelect) {
    // 복수 선택 모드 - 토글 버튼 + 선택 완료 버튼
    const selectedSet = new Set(selectedOptionIndexes);

    if (question.options && question.options.length > 0) {
      // Slack 블록 50개 제한 대응: 옵션 렌더링 전략 결정
      const trailingBlocks = 3; // submit + textInput + hint
      const availableForOptions = SLACK_BLOCK_LIMIT - blocks.length - trailingBlocks;
      const descriptionCount = question.options.filter(o => o.description).length;
      const totalWithDesc = question.options.length + descriptionCount;

      let skipDescriptions = false;
      let optionsToRender = question.options;

      if (totalWithDesc > availableForOptions) {
        skipDescriptions = true;
        if (question.options.length > availableForOptions) {
          // 잘림 안내 context 블록 1개를 위해 -1
          const maxOptions = Math.max(1, availableForOptions - 1);
          optionsToRender = question.options.slice(0, maxOptions);
        }
      }
      const isTruncated = optionsToRender.length < question.options.length;

      optionsToRender.forEach((opt, i) => {
        const isSelected = selectedSet.has(i);
        const buttonText = isSelected ? `✅ ${opt.label}` : opt.label;

        const toggleValue: ToggleOptionValue = {
          questionIndex: 0,
          optionIndex: i,
          label: opt.label,
          projectName,
          messageId,
        };

        const button: Button = {
          type: "button",
          text: { type: "plain_text", text: truncateButtonText(buttonText), emoji: true },
          value: JSON.stringify(toggleValue),
          action_id: `toggle_option_0_${i}`,
          style: isSelected ? "primary" : undefined,
        };

        blocks.push({
          type: "actions",
          elements: [button],
        } as ActionsBlock);

        // 설명이 있으면 버튼 아래에 표시 (블록 제한 시 생략)
        if (!skipDescriptions && opt.description) {
          blocks.push({
            type: "context",
            elements: [{ type: "plain_text", text: opt.description, emoji: false }],
          } as ContextBlock);
        }
      });

      if (isTruncated) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: t("question.truncatedOptions", { shown: String(optionsToRender.length), total: String(question.options.length) }) }],
        } as ContextBlock);
      }
    }

    // 선택 완료 버튼
    const submitValue: SubmitMultiSelectValue = {
      questionIndex: 0,
      projectName,
      messageId,
    };

    blocks.push({
      type: "actions",
      block_id: "submit_multi_select_0",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t("question.submitSelection"), emoji: true },
          value: JSON.stringify(submitValue),
          action_id: "submit_multi_select_0",
          style: "primary",
        } as Button,
      ],
    } as ActionsBlock);

    // 직접 입력 버튼 (멀티 선택에서도 직접 입력 가능)
    const multiSelectTextInputValue: TextInputButtonValue = {
      questionIndex: 0,
      type: "text_input",
      projectName,
      messageId,
    };

    blocks.push({
      type: "actions",
      block_id: "text_input_0",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t("question.textInput"), emoji: true },
          value: JSON.stringify(multiSelectTextInputValue),
          action_id: "text_input_0",
        } as Button,
      ],
    } as ActionsBlock);

    // 현재 선택된 항목 안내
    if (selectedOptionIndexes.length > 0) {
      const selectedLabels = selectedOptionIndexes
        .map(i => question.options[i]?.label)
        .filter(Boolean)
        .join(", ");
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: t("question.currentSelection", { labels: selectedLabels }) }],
      } as ContextBlock);
    } else {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: t("question.selectHint") }],
      } as ContextBlock);
    }
  } else {
    // 단일 선택 모드 - 기존 로직
    if (question.options && question.options.length > 0) {
      // Slack 블록 50개 제한 대응: 옵션 렌더링 전략 결정
      const trailingBlocks = 1; // textInput
      const availableForOptions = SLACK_BLOCK_LIMIT - blocks.length - trailingBlocks;
      const descriptionCount = question.options.filter(o => o.description).length;
      const totalWithDesc = question.options.length + descriptionCount;

      let skipDescriptions = false;
      let optionsToRender = question.options;

      if (totalWithDesc > availableForOptions) {
        skipDescriptions = true;
        if (question.options.length > availableForOptions) {
          const maxOptions = Math.max(1, availableForOptions - 1);
          optionsToRender = question.options.slice(0, maxOptions);
        }
      }
      const isTruncated = optionsToRender.length < question.options.length;

      optionsToRender.forEach((opt, i) => {
        const buttonValue: SelectedOptionValue = {
          questionIndex: 0,
          optionIndex: i,
          label: opt.label,
          isMultiSelect: false,
          projectName,
          messageId,
        };

        const button: Button = {
          type: "button",
          text: { type: "plain_text", text: truncateButtonText(opt.label), emoji: true },
          value: JSON.stringify(buttonValue),
          action_id: `select_option_0_${i}`,
        };

        blocks.push({
          type: "actions",
          elements: [button],
        } as ActionsBlock);

        // 설명이 있으면 버튼 아래에 표시 (블록 제한 시 생략)
        if (!skipDescriptions && opt.description) {
          blocks.push({
            type: "context",
            elements: [{ type: "plain_text", text: opt.description, emoji: false }],
          } as ContextBlock);
        }
      });

      if (isTruncated) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: t("question.truncatedOptions", { shown: String(optionsToRender.length), total: String(question.options.length) }) }],
        } as ContextBlock);
      }
    }

    // 직접 입력 버튼
    const textInputValue: TextInputButtonValue = {
      questionIndex: 0,
      type: "text_input",
      projectName,
      messageId,
    };

    blocks.push({
      type: "actions",
      block_id: "text_input_0",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t("question.textInput"), emoji: true },
          value: JSON.stringify(textInputValue),
          action_id: "text_input_0",
        } as Button,
      ],
    } as ActionsBlock);
  }

  return blocks;
}
