import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { LOG_DIR, LOG_OUT, LOG_ERR, PID_FILE } from "../core/paths.js";
import { t } from "../i18n/index.js";
import type { DaemonManager } from "./types.js";

const TASK_NAME = "TwinDevBot";
const WRAPPER_SCRIPT = join(LOG_DIR, "twindevbot-daemon.bat");

function getNodePath(): string {
  try {
    return execSync("where node", { encoding: "utf-8" }).trim().split(/\r?\n/)[0];
  } catch {
    return process.execPath;
  }
}

function getTwindevbotPath(): string {
  try {
    return execSync("where twindevbot", { encoding: "utf-8" }).trim().split(/\r?\n/)[0];
  } catch {
    return process.argv[1];
  }
}

export class WindowsDaemonManager implements DaemonManager {
  start(): void {
    // 기존 태스크가 있으면 제거
    try {
      execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: "ignore" });
    } catch {
      // 태스크가 없을 수 있음
    }

    const nodePath = getNodePath();
    const cliPath = getTwindevbotPath();

    // stdout/stderr를 로그 파일로 리다이렉션하는 래퍼 스크립트 생성
    // Task Scheduler는 기본적으로 System32 디렉토리에서 실행되므로 프로젝트 루트로 cd 필요
    const projectRoot = process.cwd();
    const scriptContent = `@echo off\r\ncd /d "${projectRoot}"\r\n"${nodePath}" "${cliPath}" start 1>>"${LOG_OUT}" 2>>"${LOG_ERR}"\r\n`;
    writeFileSync(WRAPPER_SCRIPT, scriptContent);

    const command = `"\\"${WRAPPER_SCRIPT}\\""`;

    try {
      execSync(
        `schtasks /create /tn "${TASK_NAME}" /tr ${command} /sc onlogon /rl limited /f`,
      );
      console.log(t("cli.daemon.taskCreated", { name: TASK_NAME }));

      // 태스크를 즉시 실행
      execSync(`schtasks /run /tn "${TASK_NAME}"`, { stdio: "ignore" });
      console.log(t("cli.daemon.started"));
      console.log("");
      console.log(`  Status:  twindevbot status`);
      console.log(`  Stop:    twindevbot stop`);
      console.log(`  Logs:    ${this.getLogViewCommand(LOG_ERR)}`);
    } catch (err) {
      console.error(t("cli.daemon.failedToStart"), err);
      process.exit(1);
    }
  }

  stop(): void {
    // PID 파일로 프로세스 트리 전체 종료 (자식 Claude 프로세스 포함)
    // schtasks /end는 최상위 프로세스만 종료하므로 자식 프로세스가 고아가 됨
    if (existsSync(PID_FILE)) {
      try {
        const pid = readFileSync(PID_FILE, "utf-8").trim();
        if (!/^\d+$/.test(pid)) {
          throw new Error("Invalid PID");
        }
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      } catch {
        // 프로세스가 이미 종료되었을 수 있음
      }
      try {
        unlinkSync(PID_FILE);
      } catch {
        // 파일 삭제 실패 무시
      }
    }

    // 실행 중인 태스크 종료 (PID 파일이 없는 경우 대비)
    try {
      execSync(`schtasks /end /tn "${TASK_NAME}"`, { stdio: "ignore" });
    } catch {
      // 실행 중이 아닐 수 있음
    }

    // 태스크 삭제
    try {
      execSync(`schtasks /delete /tn "${TASK_NAME}" /f`);
      console.log(t("cli.daemon.stopped"));
    } catch {
      console.log(t("cli.daemon.notInstalled"));
    }

    // 래퍼 스크립트 정리
    if (existsSync(WRAPPER_SCRIPT)) {
      unlinkSync(WRAPPER_SCRIPT);
    }
  }

  status(): void {
    try {
      const output = execSync(
        `schtasks /query /tn "${TASK_NAME}" /v /fo list`,
        { encoding: "utf-8" },
      );

      const statusMatch = output.match(/Status:\s*(.+)/);
      if (statusMatch && statusMatch[1].trim() === "Running") {
        let pid = "-";
        if (existsSync(PID_FILE)) {
          try {
            pid = readFileSync(PID_FILE, "utf-8").trim();
          } catch {
            // PID 파일 읽기 실패
          }
        }
        console.log(t("cli.status.running", { pid }));
      } else {
        console.log(t("cli.status.registered"));
      }

      console.log(`  Logs: ${this.getLogViewCommand(LOG_ERR)}`);
    } catch {
      console.log(t("cli.status.notInstalled"));
      console.log(t("cli.status.notInstalledHint"));
    }
  }

  isRunning(): boolean {
    try {
      const output = execSync(
        `schtasks /query /tn "${TASK_NAME}" /v /fo list`,
        { encoding: "utf-8" },
      );
      const statusMatch = output.match(/Status:\s*(.+)/);
      return !!(statusMatch && statusMatch[1].trim() === "Running");
    } catch {
      return false;
    }
  }

  getLogViewCommand(logPath: string): string {
    return `Get-Content "${logPath}" -Wait`;
  }
}
