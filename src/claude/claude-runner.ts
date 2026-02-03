import { spawn, execSync, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { createLogger } from "../core/logger.js";
import type {
  ClaudeStreamEvent,
  ClaudeInitEvent,
  ClaudeAssistantMessage,
  ClaudeResultEvent,
} from "../types/claude-stream.js";
import { buildStreamJsonMessage } from "../utils/claude-content-builder.js";
import type { DownloadedFile } from "../utils/slack-file-downloader.js";

const log = createLogger("claude-runner");

export interface ClaudeRunnerOptions {
  directory: string;
  prompt: string;
  sessionId?: string; // 있으면 --resume 사용
  files?: DownloadedFile[]; // 첨부 파일 (있으면 stream-json 입력 모드 사용)
}

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface AskUserEvent {
  input: AskUserQuestionInput;
}

export interface InitEvent {
  sessionId: string;
  model?: string;
}

export interface TextEvent {
  text: string;
}

export interface ToolUseEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ResultEvent {
  result?: string;
  costUsd?: number;
}

export class ClaudeRunner extends EventEmitter {
  private sessionId: string | null = null;
  private process: ChildProcess | null = null;

  // 중복 방지용 상태
  /** 이미 처리한 tool_use ID를 추적 */
  private processedToolUseIds: Set<string> = new Set();
  /** init 이벤트 발생 여부 */
  private initEmitted: boolean = false;
  /** result 이벤트 발생 여부 */
  private resultEmitted: boolean = false;
  /** stderr 출력 누적 버퍼 */
  private stderrLines: string[] = [];
  constructor(private options: ClaudeRunnerOptions) {
    super();
    this.sessionId = options.sessionId || null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** 누적된 stderr 출력을 반환 */
  get stderrOutput(): string {
    return this.stderrLines.join("").trim();
  }

  run(): void {
    const hasFiles = this.options.files && this.options.files.length > 0;

    // 파일이 있으면 stream-json 입력 모드 사용, 없으면 기존 -p 방식
    const args = hasFiles
      ? [
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
        ]
      : [
          "-p", this.options.prompt,
          "--output-format", "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
        ];

    // 세션 ID가 있으면 --resume 추가
    if (this.options.sessionId) {
      args.unshift("--resume", this.options.sessionId);
    }

    log.info("Running Claude", {
      directory: this.options.directory,
      prompt: this.options.prompt,
      sessionId: this.options.sessionId || "new",
      hasFiles,
      fileCount: this.options.files?.length || 0,
    });

    // 파일이 있으면 stdin을 pipe로, 없으면 ignore로 설정
    const stdinMode = hasFiles ? "pipe" : "ignore";

    this.process = spawn("claude", args, {
      cwd: this.options.directory,
      stdio: [stdinMode, "pipe", "pipe"],
      shell: process.platform === "win32", // Windows에서 .cmd/.exe PATH 해석에 필요
    });

    // 파일이 있으면 stdin에 stream-json 메시지 작성 후 닫기
    if (hasFiles && this.process.stdin) {
      const stdin = this.process.stdin;
      const message = buildStreamJsonMessage(this.options.prompt, this.options.files!);

      log.info("Writing stream-json message to stdin", {
        messageLength: message.length,
        fileNames: this.options.files!.map(f => f.name),
        fileSizes: this.options.files!.map(f => f.data.length),
      });

      // stdin 에러 핸들러 등록
      stdin.on("error", (err) => {
        log.error("stdin write error", { error: err.message });
        this.emit("error", err);
      });

      // 쓰기 시도
      const writeSuccess = stdin.write(message + "\n", "utf-8", (err) => {
        if (err) {
          log.error("stdin write callback error", { error: err.message });
          this.emit("error", err);
          return;
        }
        stdin.end();
        log.info("stdin write complete and closed");
      });

      // 버퍼가 가득 찼으면 drain 대기
      if (!writeSuccess) {
        log.debug("stdin buffer full, waiting for drain");
        stdin.once("drain", () => {
          log.debug("stdin drained");
        });
      }
    }

    let buffer = "";

    this.process.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      buffer += chunk;

      // 줄 단위로 파싱
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.handleLine(trimmed);
        }
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      log.debug("Claude stderr", { text });
      this.stderrLines.push(text);
    });

    this.process.on("error", (err) => {
      log.error("Claude process error", { error: err.message });
      this.emit("error", err);
    });

    this.process.on("exit", (code) => {
      log.info("Claude process exited", { code });
      // 남은 버퍼 처리
      if (buffer.trim()) {
        this.handleLine(buffer.trim());
      }
      this.emit("exit", code);
    });
  }

  private handleLine(line: string): void {
    log.debug("Claude output", { line });

    try {
      const event = JSON.parse(line) as ClaudeStreamEvent;
      this.handleEvent(event);
    } catch {
      // Non-JSON output from Claude CLI (e.g., progress messages)
      log.debug("Non-JSON line from Claude (ignored)", { line: line.slice(0, 200) });
    }
  }

  private handleEvent(event: ClaudeStreamEvent): void {
    log.debug("Claude event", { type: event.type });

    switch (event.type) {
      case "system":
        if ("subtype" in event && event.subtype === "init") {
          // 중복 init 방지
          if (this.initEmitted) {
            log.debug("Skipping duplicate init event");
            break;
          }
          this.initEmitted = true;

          const initEvent = event as ClaudeInitEvent;
          this.sessionId = initEvent.session_id;

          this.emit("init", {
            sessionId: initEvent.session_id,
            model: initEvent.model,
          } as InitEvent);
        }
        break;

      case "assistant":
        const msg = (event as ClaudeAssistantMessage).message;
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              this.emit("text", { text: block.text } as TextEvent);
            } else if (block.type === "tool_use" && block.name) {
              // tool_use 블록 수신 시 전체 구조를 로그로 기록 (문제 진단용)
              log.debug("tool_use block received", {
                id: block.id,
                name: block.name,
                hasId: !!block.id,
                blockKeys: Object.keys(block),
              });

              // 중복 tool_use 필터링 (id가 있는 경우)
              const toolUseId = block.id as string | undefined;
              if (toolUseId && this.processedToolUseIds.has(toolUseId)) {
                log.info("Skipping duplicate tool_use", { toolUseId, toolName: block.name });
                continue;
              }
              if (toolUseId) {
                this.processedToolUseIds.add(toolUseId);
              }

              const toolEvent: ToolUseEvent = {
                toolName: block.name,
                input: block.input || {},
              };
              this.emit("toolUse", toolEvent);

              // AskUserQuestion 처리 흐름:
              // ─────────────────────────────────────────────────────────────
              // 1. Claude CLI가 AskUserQuestion tool_use를 출력
              // 2. 여기서 "askUser" 이벤트를 emit
              // 3. claude-runner-setup.ts의 핸들러가 Slack 스레드로 질문 블록 전송
              // 4. Slack 전송 완료 후 runner.kill()을 호출하여 프로세스를 종료
              //    - stdin이 "ignore"라서 Claude CLI가 응답을 받을 수 없음
              //    - 종료하지 않으면 Claude가 에러를 받고 같은 질문을 반복함
              // 5. 사용자가 Slack에서 버튼 클릭 또는 직접 입력으로 응답
              // 6. question-handlers.ts에서 --resume으로 새 프로세스를 시작
              // ─────────────────────────────────────────────────────────────
              if (block.name === "AskUserQuestion") {
                this.emit("askUser", {
                  input: block.input as unknown as AskUserQuestionInput,
                } as AskUserEvent);
              }

              // ExitPlanMode 처리:
              // stdin이 "ignore"라 CLI가 사용자 승인을 받을 수 없어 실패함.
              // askUser와 동일한 패턴으로 프로세스 kill → resume으로 처리.
              if (block.name === "ExitPlanMode") {
                this.emit("exitPlanMode", {});
              }
            }
          }
        }
        break;

      case "result":
        // 중복 result 방지
        if (this.resultEmitted) {
          log.debug("Skipping duplicate result event");
          break;
        }
        this.resultEmitted = true;

        const resultEvent = event as ClaudeResultEvent;
        this.emit("result", {
          result: resultEvent.result,
          costUsd: resultEvent.total_cost_usd,
        } as ResultEvent);
        break;
    }
  }

  kill(): void {
    if (this.process) {
      if (process.platform === "win32" && this.process.pid) {
        // Windows에서 shell: true 사용 시 프로세스 트리 전체를 종료해야 함
        try {
          execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: "ignore" });
        } catch {
          this.process.kill();
        }
      } else {
        try {
          this.process.kill();
        } catch {
          // Process already exited - ignore ESRCH
        }
      }
      this.process = null;
    }
  }
}

export function runClaude(options: ClaudeRunnerOptions): ClaudeRunner {
  const runner = new ClaudeRunner(options);
  runner.run();
  return runner;
}
