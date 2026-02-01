import { createWriteStream, type WriteStream } from "fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function safeStringify(data: unknown): string {
  if (data instanceof Error) {
    return JSON.stringify({ message: data.message, stack: data.stack });
  }
  try {
    return JSON.stringify(data);
  } catch {
    return "[unserializable]";
  }
}

class Logger {
  private level: LogLevel;
  private context?: string;
  private static logStream: WriteStream | null = null;

  constructor(level: LogLevel = "info", context?: string) {
    this.level = level;
    this.context = context;
  }

  static enableFileLogging(filePath: string): void {
    if (Logger.logStream) {
      Logger.logStream.end();
    }
    Logger.logStream = createWriteStream(filePath, { flags: "a" });
    Logger.logStream.on("error", (err) => {
      console.error("Log file write error:", err.message);
    });
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const prefix = this.context ? `[${this.context}] ` : "";
    const dataStr = data !== undefined ? ` ${safeStringify(data)}` : "";
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix}${message}${dataStr}`;
  }

  private output(formatted: string): void {
    console.error(formatted);
    Logger.logStream?.write(formatted + "\n");
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog("debug")) {
      this.output(this.formatMessage("debug", message, data));
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog("info")) {
      this.output(this.formatMessage("info", message, data));
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog("warn")) {
      this.output(this.formatMessage("warn", message, data));
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog("error")) {
      const errorData = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : error;
      this.output(this.formatMessage("error", message, errorData));
    }
  }

  child(context: string): Logger {
    const childContext = this.context ? `${this.context}:${context}` : context;
    return new Logger(this.level, childContext);
  }
}

const VALID_LOG_LEVELS = new Set<string>(Object.keys(LOG_LEVELS));

function parseLogLevel(envValue: string | undefined): LogLevel {
  if (envValue && VALID_LOG_LEVELS.has(envValue)) {
    return envValue as LogLevel;
  }
  if (envValue) {
    console.error(
      `Invalid LOG_LEVEL "${envValue}". Valid values: ${[...VALID_LOG_LEVELS].join(", ")}. Falling back to "info".`,
    );
  }
  return "info";
}

export const logger = new Logger(parseLogLevel(process.env.LOG_LEVEL));

export function createLogger(context: string): Logger {
  return logger.child(context);
}

export function enableFileLogging(filePath: string): void {
  Logger.enableFileLogging(filePath);
}

/**
 * Slack Bolt용 로거 어댑터.
 * Bolt 내부 로그를 커스텀 로거로 라우팅하여
 * 타임스탬프 + stderr 출력을 일관되게 유지한다.
 */
export function createBoltLogger(): {
  debug(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
  setLevel(level: string): void;
  getLevel(): string;
  setName(name: string): void;
} {
  let boltLog = logger.child("bolt");

  return {
    debug(...msg: unknown[]) { boltLog.debug(msg.map(String).join(" ")); },
    info(...msg: unknown[]) { boltLog.info(msg.map(String).join(" ")); },
    warn(...msg: unknown[]) { boltLog.warn(msg.map(String).join(" ")); },
    error(...msg: unknown[]) { boltLog.error(msg.map(String).join(" ")); },
    setLevel() { /* level is controlled by LOG_LEVEL env */ },
    getLevel() { return "info"; },
    setName(name: string) { boltLog = logger.child(name); },
  };
}
