// 버튼 액션 값 타입
// 주의: questionText, header 등 큰 필드는 action-payload-store에 저장.
// 버튼 value에는 짧은 필드만 포함하여 Slack의 action.value 2,000바이트 제한 준수.
export interface SelectedOptionValue {
  questionIndex: number;
  optionIndex: number;
  label: string;
  isMultiSelect: boolean;
  projectName: string;
  messageId: string;
}

// 복수 선택 토글 버튼 값
export interface ToggleOptionValue {
  questionIndex: number;
  optionIndex: number;
  label: string;
  projectName: string;
  messageId: string;
}

// 복수 선택 완료 버튼 값
export interface SubmitMultiSelectValue {
  questionIndex: number;
  projectName: string;
  messageId: string;
}

export interface TextInputButtonValue {
  questionIndex: number;
  type: "text_input";
  projectName: string;
  messageId: string;
}

// Modal 메타데이터 타입
// questionText, header는 action-payload-store에서 messageId로 조회
export interface TextInputModalMetadata {
  requestId: string; // `${projectName}:${messageId}` 형식
  questionIndex: number;
  channelId: string;
  messageTs: string;
  threadTs: string; // 스레드 부모 ts (세션 조회용)
}

// Autopilot/일반 모드 개입 확인 버튼 값
// userMessage는 action-payload-store에 `interrupt:${threadTs}:${userMessageTs}` 키로 저장
export interface AutopilotInterruptValue {
  threadTs: string;
  channelId: string;
  projectName: string;
  userMessageTs?: string;
}

// action-payload-store에 저장되는 질문 관련 데이터
export interface StoredQuestionPayload {
  questionText: string;
  header?: string;
  optionLabels?: string[];
}

// /twindevbot init 디렉토리 선택 버튼 값
export interface InitDirSelectValue {
  dirName: string;
}

// /twindevbot init 직접 입력 모달 메타데이터
export interface InitCustomDirModalMetadata {
  channelId: string;
  originalMessageTs: string;
}
