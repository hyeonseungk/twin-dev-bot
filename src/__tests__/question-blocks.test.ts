import { vi, describe, it, expect } from "vitest";

vi.mock("../i18n/index.js", () => ({
  t: vi.fn((key: string) => key),
}));

import { buildQuestionBlocks } from "../slack/question-blocks.js";
import { createMockQuestion } from "./helpers/mock-factories.js";

const baseOptions = {
  projectName: "test-project",
  messageId: "msg-001",
};

describe("buildQuestionBlocks", () => {
  it("returns blocks for a valid question", () => {
    const question = createMockQuestion();
    const blocks = buildQuestionBlocks({
      ...baseOptions,
      question,
    });
    expect(blocks.length).toBeGreaterThan(0);
  });

  describe("header and structure", () => {
    it("includes header block", () => {
      const question = createMockQuestion();
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const header = blocks.find((b) => b.type === "header");
      expect(header).toBeDefined();
      expect((header as any).text.text).toBe("question.header");
    });

    it("includes question.header as section when present", () => {
      const question = createMockQuestion({ header: "My Header" });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const sections = blocks.filter((b) => b.type === "section");
      // First section is the header text, second is the question text
      expect(sections.length).toBeGreaterThanOrEqual(2);
      expect((sections[0] as any).text.text).toBe("*My Header*");
    });

    it("includes question.question as section", () => {
      const question = createMockQuestion({ question: "Pick a DB?" });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const sections = blocks.filter((b) => b.type === "section");
      const questionSection = sections.find(
        (s) => (s as any).text.text === "Pick a DB?"
      );
      expect(questionSection).toBeDefined();
    });

    it("includes divider", () => {
      const question = createMockQuestion();
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const divider = blocks.find((b) => b.type === "divider");
      expect(divider).toBeDefined();
    });
  });

  describe("submitted state", () => {
    it("shows completed header when isSubmitted", () => {
      const question = createMockQuestion();
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
        isSubmitted: true,
        selectedAnswer: "PostgreSQL",
      });

      const header = blocks.find((b) => b.type === "header");
      expect((header as any).text.text).toBe("question.headerCompleted");
    });

    it("shows selected answer with checkmark", () => {
      const question = createMockQuestion();
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
        isSubmitted: true,
        selectedAnswer: "PostgreSQL",
      });

      const sections = blocks.filter((b) => b.type === "section");
      const answerSection = sections.find(
        (s) => (s as any).text.text.includes("PostgreSQL")
      );
      expect(answerSection).toBeDefined();
      // Matches the format in source: `✅ *${selectedAnswer}*`
      expect((answerSection as any).text.text).toContain("*PostgreSQL*");
    });

    it("does not render option buttons when submitted", () => {
      const question = createMockQuestion();
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
        isSubmitted: true,
        selectedAnswer: "PostgreSQL",
      });

      const actions = blocks.filter((b) => b.type === "actions");
      expect(actions).toHaveLength(0);
    });
  });

  describe("single select", () => {
    it("renders action block per option", () => {
      const question = createMockQuestion({
        multiSelect: false,
        options: [
          { label: "A" },
          { label: "B" },
          { label: "C" },
        ],
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      // One actions block per option + one for text_input
      const actions = blocks.filter((b) => b.type === "actions");
      expect(actions.length).toBe(4); // 3 options + 1 text_input
    });

    it("includes text_input button", () => {
      const question = createMockQuestion();
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const textInputAction = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "text_input_0"
        )
      );
      expect(textInputAction).toBeDefined();
    });

    it("button values contain correct JSON structure", () => {
      const question = createMockQuestion({
        question: "Pick a DB?",
        options: [{ label: "PostgreSQL" }],
        multiSelect: false,
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const optionAction = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "select_option_0_0"
        )
      );
      expect(optionAction).toBeDefined();

      const button = (optionAction as any).elements[0];
      const value = JSON.parse(button.value);
      expect(value).toMatchObject({
        questionIndex: 0,
        optionIndex: 0,
        label: "PostgreSQL",
        isMultiSelect: false,
        projectName: "test-project",
        messageId: "msg-001",
      });
      // questionText는 action-payload-store에 별도 저장 (Slack value 크기 제한 대응)
      expect(value.questionText).toBeUndefined();
    });

    it("includes context for options with description", () => {
      const question = createMockQuestion({
        options: [
          { label: "PostgreSQL", description: "Relational DB" },
        ],
        multiSelect: false,
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const context = blocks.filter((b) => b.type === "context");
      expect(context.length).toBeGreaterThanOrEqual(1);
      const descContext = context.find((c) =>
        (c as any).elements?.some(
          (el: any) => el.text === "Relational DB"
        )
      );
      expect(descContext).toBeDefined();
    });

    it("truncates button text to 75 chars with ellipsis", () => {
      const longLabel = "A".repeat(100);
      const question = createMockQuestion({
        options: [{ label: longLabel }],
        multiSelect: false,
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      // Find the option button (not the text_input button)
      const optionAction = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "select_option_0_0"
        )
      );
      expect(optionAction).toBeDefined();
      const buttonText = (optionAction as any).elements[0].text.text;
      expect(buttonText.length).toBeLessThanOrEqual(75);
      expect(buttonText).toMatch(/…$/);
    });

    it("does not add ellipsis when button text is within limit", () => {
      const shortLabel = "Short label";
      const question = createMockQuestion({
        options: [{ label: shortLabel }],
        multiSelect: false,
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const optionAction = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "select_option_0_0"
        )
      );
      expect(optionAction).toBeDefined();
      const buttonText = (optionAction as any).elements[0].text.text;
      expect(buttonText).toBe(shortLabel);
      expect(buttonText).not.toMatch(/…$/);
    });
  });

  describe("multi select", () => {
    it("renders toggle buttons", () => {
      const question = createMockQuestion({
        multiSelect: true,
        options: [
          { label: "A" },
          { label: "B" },
        ],
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const toggleActions = actions.filter((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id?.startsWith("toggle_option_")
        )
      );
      expect(toggleActions.length).toBe(2);
    });

    it("selected options have checkmark prefix and primary style", () => {
      const question = createMockQuestion({
        multiSelect: true,
        options: [
          { label: "A" },
          { label: "B" },
        ],
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
        selectedOptionIndexes: [0],
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const toggleAction0 = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "toggle_option_0_0"
        )
      );
      expect(toggleAction0).toBeDefined();

      const button = (toggleAction0 as any).elements[0];
      expect(button.text.text).toMatch(/^✅/);
      expect(button.style).toBe("primary");

      // Unselected button should not have primary style
      const toggleAction1 = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "toggle_option_0_1"
        )
      );
      const button1 = (toggleAction1 as any).elements[0];
      expect(button1.text.text).not.toMatch(/^✅/);
      expect(button1.style).toBeUndefined();
    });

    it("includes submit button", () => {
      const question = createMockQuestion({ multiSelect: true });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const submitAction = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "submit_multi_select_0"
        )
      );
      expect(submitAction).toBeDefined();

      const submitButton = (submitAction as any).elements[0];
      expect(submitButton.style).toBe("primary");
      expect(submitButton.text.text).toBe("question.submitSelection");
    });

    it("includes text_input button", () => {
      const question = createMockQuestion({ multiSelect: true });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
      });

      const actions = blocks.filter((b) => b.type === "actions");
      const textInputAction = actions.find((a) =>
        (a as any).elements?.some(
          (el: any) => el.action_id === "text_input_0"
        )
      );
      expect(textInputAction).toBeDefined();
    });

    it("shows currentSelection when options selected", () => {
      const question = createMockQuestion({
        multiSelect: true,
        options: [
          { label: "A" },
          { label: "B" },
          { label: "C" },
        ],
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
        selectedOptionIndexes: [0, 2],
      });

      const contextBlocks = blocks.filter((b) => b.type === "context");
      // The last context block should show current selection
      const lastContext = contextBlocks[contextBlocks.length - 1];
      expect((lastContext as any).elements[0].text).toContain(
        "question.currentSelection"
      );
    });

    it("shows selectHint when no options selected", () => {
      const question = createMockQuestion({
        multiSelect: true,
        options: [
          { label: "A" },
          { label: "B" },
        ],
      });
      const blocks = buildQuestionBlocks({
        ...baseOptions,
        question,
        selectedOptionIndexes: [],
      });

      const contextBlocks = blocks.filter((b) => b.type === "context");
      const lastContext = contextBlocks[contextBlocks.length - 1];
      expect((lastContext as any).elements[0].text).toBe("question.selectHint");
    });
  });

  describe("Slack block limit (50)", () => {
    function makeOptions(count: number, withDescription = false) {
      return Array.from({ length: count }, (_, i) => ({
        label: `Option ${i}`,
        ...(withDescription ? { description: `Desc ${i}` } : {}),
      }));
    }

    describe("single select", () => {
      it("skips descriptions when block count would exceed 50", () => {
        // header(1) + questionHeader(1) + question(1) + divider(1) = 4 fixed leading
        // textInput(1) = 1 fixed trailing
        // 25 options with desc = 25 actions + 25 context = 50 option blocks
        // Total: 4 + 50 + 1 = 55 > 50 → should skip descriptions
        const question = createMockQuestion({
          multiSelect: false,
          options: makeOptions(25, true),
        });
        const blocks = buildQuestionBlocks({
          ...baseOptions,
          question,
        });

        // descriptions should be skipped
        const contextBlocks = blocks.filter((b) => b.type === "context");
        const descContext = contextBlocks.filter((c) =>
          (c as any).elements?.some((el: any) => el.text?.startsWith("Desc"))
        );
        expect(descContext).toHaveLength(0);

        // all 25 option buttons should still be present
        const actions = blocks.filter((b) => b.type === "actions");
        const optionActions = actions.filter((a) =>
          (a as any).elements?.some((el: any) => el.action_id?.startsWith("select_option_"))
        );
        expect(optionActions).toHaveLength(25);

        expect(blocks.length).toBeLessThanOrEqual(50);
      });

      it("truncates options when too many even without descriptions", () => {
        // header(1) + questionHeader(1) + question(1) + divider(1) = 4 fixed leading
        // textInput(1) = 1 fixed trailing
        // available = 50 - 4 - 1 = 45
        // 46 options (no desc) → 46 > 45 → truncate to 44 (45-1 for truncation notice)
        const question = createMockQuestion({
          multiSelect: false,
          options: makeOptions(46),
        });
        const blocks = buildQuestionBlocks({
          ...baseOptions,
          question,
        });

        const actions = blocks.filter((b) => b.type === "actions");
        const optionActions = actions.filter((a) =>
          (a as any).elements?.some((el: any) => el.action_id?.startsWith("select_option_"))
        );
        expect(optionActions.length).toBeLessThan(46);

        // truncation notice should be present
        const contextBlocks = blocks.filter((b) => b.type === "context");
        const truncationNotice = contextBlocks.find((c) =>
          (c as any).elements?.some((el: any) => el.text?.includes("question.truncatedOptions"))
        );
        expect(truncationNotice).toBeDefined();

        expect(blocks.length).toBeLessThanOrEqual(50);
      });

      it("does not modify blocks when under the limit", () => {
        const question = createMockQuestion({
          multiSelect: false,
          options: makeOptions(3, true),
        });
        const blocks = buildQuestionBlocks({
          ...baseOptions,
          question,
        });

        // descriptions should be present
        const contextBlocks = blocks.filter((b) => b.type === "context");
        const descContext = contextBlocks.filter((c) =>
          (c as any).elements?.some((el: any) => el.text?.startsWith("Desc"))
        );
        expect(descContext).toHaveLength(3);
        expect(blocks.length).toBeLessThanOrEqual(50);
      });
    });

    describe("multi select", () => {
      it("skips descriptions when block count would exceed 50", () => {
        // header(1) + questionHeader(1) + question(1) + divider(1) = 4 fixed leading
        // submit(1) + textInput(1) + hint(1) = 3 fixed trailing
        // 22 options with desc = 22 actions + 22 context = 44 option blocks
        // Total: 4 + 44 + 3 = 51 > 50 → should skip descriptions
        const question = createMockQuestion({
          multiSelect: true,
          options: makeOptions(22, true),
        });
        const blocks = buildQuestionBlocks({
          ...baseOptions,
          question,
        });

        const contextBlocks = blocks.filter((b) => b.type === "context");
        const descContext = contextBlocks.filter((c) =>
          (c as any).elements?.some((el: any) => el.text?.startsWith("Desc"))
        );
        expect(descContext).toHaveLength(0);

        // all 22 toggle buttons should still be present
        const actions = blocks.filter((b) => b.type === "actions");
        const toggleActions = actions.filter((a) =>
          (a as any).elements?.some((el: any) => el.action_id?.startsWith("toggle_option_"))
        );
        expect(toggleActions).toHaveLength(22);

        expect(blocks.length).toBeLessThanOrEqual(50);
      });

      it("truncates options when too many even without descriptions", () => {
        // header(1) + questionHeader(1) + question(1) + divider(1) = 4 fixed leading
        // submit(1) + textInput(1) + hint(1) = 3 fixed trailing
        // available = 50 - 4 - 3 = 43
        // 44 options → 44 > 43 → truncate to 42 (43-1 for truncation notice)
        const question = createMockQuestion({
          multiSelect: true,
          options: makeOptions(44),
        });
        const blocks = buildQuestionBlocks({
          ...baseOptions,
          question,
        });

        const actions = blocks.filter((b) => b.type === "actions");
        const toggleActions = actions.filter((a) =>
          (a as any).elements?.some((el: any) => el.action_id?.startsWith("toggle_option_"))
        );
        expect(toggleActions.length).toBeLessThan(44);

        // truncation notice should be present
        const contextBlocks = blocks.filter((b) => b.type === "context");
        const truncationNotice = contextBlocks.find((c) =>
          (c as any).elements?.some((el: any) => el.text?.includes("question.truncatedOptions"))
        );
        expect(truncationNotice).toBeDefined();

        expect(blocks.length).toBeLessThanOrEqual(50);
      });

      it("does not modify blocks when under the limit", () => {
        const question = createMockQuestion({
          multiSelect: true,
          options: makeOptions(3, true),
        });
        const blocks = buildQuestionBlocks({
          ...baseOptions,
          question,
        });

        const contextBlocks = blocks.filter((b) => b.type === "context");
        const descContext = contextBlocks.filter((c) =>
          (c as any).elements?.some((el: any) => el.text?.startsWith("Desc"))
        );
        expect(descContext).toHaveLength(3);
        expect(blocks.length).toBeLessThanOrEqual(50);
      });
    });
  });
});
