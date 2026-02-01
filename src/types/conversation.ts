/**
 * 질문 관련 타입 정의
 */

/**
 * 질문 (AskUserQuestion의 questions 배열 항목)
 */
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}
