// Claude CLI `--output-format stream-json --verbose` raw stdout 타입 정의
// 실제 CLI 출력을 기반으로 정의 (공식 스펙 문서 없음, CLI v2.1.25 기준)

export interface ClaudeInitEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: string;
  slash_commands: string[];
  apiKeySource: string;
  claude_code_version: string;
  output_style: string;
  agents: string[];
  skills: string[];
  plugins: string[];
  uuid: string;
}

export interface ClaudeAssistantMessage {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeContentBlock[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: ClaudeUsage;
    context_management: unknown | null;
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

/** assistant 메시지의 content block */
export interface ClaudeContentBlock {
  type: "text" | "tool_use";
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** tool result를 담는 user 메시지 (도구 실행 후 Claude에게 결과를 전달) */
export interface ClaudeUserMessage {
  type: "user";
  message: {
    role: "user";
    content: Array<{
      tool_use_id: string;
      type: "tool_result";
      content: string;
    }>;
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
  tool_use_result: {
    type: string;
    file?: {
      filePath: string;
      content: string;
      numLines: number;
      startLine: number;
      totalLines: number;
    };
  };
}

export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: ClaudeUsage;
  modelUsage: Record<string, ClaudeModelUsage>;
  permission_denials: Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }>;
  uuid: string;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier?: string;
}

export interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export type ClaudeStreamEvent =
  | ClaudeInitEvent
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResultEvent;
