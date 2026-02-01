import { describe, it, expect, beforeEach } from "vitest";
import {
  initPendingBatch,
  hasPendingBatch,
  recordAnswerAndAdvance,
  buildCombinedAnswer,
  clearPendingBatch,
} from "../stores/pending-questions.js";
import type { Question } from "../types/conversation.js";

describe("pending-questions", () => {
  const threadTs = "thread-1";

  beforeEach(() => {
    clearPendingBatch(threadTs);
  });

  describe("initPendingBatch / hasPendingBatch", () => {
    it("initializes batch and reports existence", () => {
      expect(hasPendingBatch(threadTs)).toBe(false);

      const questions: Question[] = [
        { question: "Q1?", options: [{ label: "A" }] },
        { question: "Q2?", options: [{ label: "B" }] },
      ];
      initPendingBatch(threadTs, questions, "proj", "C123");

      expect(hasPendingBatch(threadTs)).toBe(true);
    });

    it("returns false for unknown thread", () => {
      expect(hasPendingBatch("unknown")).toBe(false);
    });
  });

  describe("recordAnswerAndAdvance", () => {
    it("advances through questions sequentially", () => {
      const questions: Question[] = [
        { question: "Q1?", header: "H1", options: [{ label: "A" }] },
        { question: "Q2?", header: "H2", options: [{ label: "B" }] },
        { question: "Q3?", header: "H3", options: [{ label: "C" }] },
      ];
      initPendingBatch(threadTs, questions, "proj", "C123");

      // Answer Q1 -> Q2 should be next
      const r1 = recordAnswerAndAdvance(threadTs, "Answer1");
      expect(r1).not.toBeNull();
      expect(r1!.done).toBe(false);
      expect(r1!.nextQuestion).toEqual(questions[1]);
      expect(r1!.batch.currentIndex).toBe(1);

      // Answer Q2 -> Q3 should be next
      const r2 = recordAnswerAndAdvance(threadTs, "Answer2");
      expect(r2).not.toBeNull();
      expect(r2!.done).toBe(false);
      expect(r2!.nextQuestion).toEqual(questions[2]);
      expect(r2!.batch.currentIndex).toBe(2);

      // Answer Q3 -> done
      const r3 = recordAnswerAndAdvance(threadTs, "Answer3");
      expect(r3).not.toBeNull();
      expect(r3!.done).toBe(true);
      expect(r3!.nextQuestion).toBeUndefined();
      expect(r3!.batch.answers).toEqual(["Answer1", "Answer2", "Answer3"]);
    });

    it("returns null when no batch exists", () => {
      expect(recordAnswerAndAdvance("no-batch", "answer")).toBeNull();
    });
  });

  describe("buildCombinedAnswer", () => {
    it("builds combined answer with headers", () => {
      const questions: Question[] = [
        { question: "Which library?", header: "Library", options: [] },
        { question: "Which approach?", header: "Approach", options: [] },
      ];
      initPendingBatch(threadTs, questions, "proj", "C123");
      recordAnswerAndAdvance(threadTs, "React");
      recordAnswerAndAdvance(threadTs, "Tailwind");

      const result = buildCombinedAnswer(threadTs);
      expect(result).toBe("[Library]: React\n[Approach]: Tailwind");
    });

    it("falls back to question text when no header", () => {
      const questions: Question[] = [
        { question: "Which library should we use?", options: [] },
        { question: "Which approach do you prefer?", options: [] },
      ];
      initPendingBatch(threadTs, questions, "proj", "C123");
      recordAnswerAndAdvance(threadTs, "React");
      recordAnswerAndAdvance(threadTs, "Tailwind");

      const result = buildCombinedAnswer(threadTs);
      expect(result).toBe(
        "[Which library should we use?]: React\n[Which approach do you prefer?]: Tailwind"
      );
    });

    it("returns answer directly for single question batch", () => {
      const questions: Question[] = [
        { question: "Q1?", options: [] },
      ];
      initPendingBatch(threadTs, questions, "proj", "C123");
      recordAnswerAndAdvance(threadTs, "MyAnswer");

      expect(buildCombinedAnswer(threadTs)).toBe("MyAnswer");
    });

    it("returns null when no batch exists", () => {
      expect(buildCombinedAnswer("no-batch")).toBeNull();
    });
  });

  describe("clearPendingBatch", () => {
    it("removes the batch", () => {
      const questions: Question[] = [
        { question: "Q1?", options: [] },
        { question: "Q2?", options: [] },
      ];
      initPendingBatch(threadTs, questions, "proj", "C123");
      expect(hasPendingBatch(threadTs)).toBe(true);

      clearPendingBatch(threadTs);
      expect(hasPendingBatch(threadTs)).toBe(false);
    });

    it("does nothing for non-existent batch", () => {
      // Should not throw
      clearPendingBatch("no-batch");
      expect(hasPendingBatch("no-batch")).toBe(false);
    });
  });
});
