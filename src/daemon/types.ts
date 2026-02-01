export interface DaemonManager {
  start(): void;
  stop(): void;
  status(): void;
  /** 데몬이 현재 실행 중인지 확인 */
  isRunning(): boolean;
  /** 플랫폼에 맞는 로그 조회 명령어 */
  getLogViewCommand(logPath: string): string;
}
