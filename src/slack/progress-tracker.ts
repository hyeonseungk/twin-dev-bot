import type { WebClient } from "@slack/web-api";
import { createLogger } from "../core/logger.js";
import {
  addReaction,
  removeReaction,
  postThreadMessage,
} from "../utils/slack-message.js";
import { withRetry } from "../utils/slack-rate-limit.js";
import { t, type TranslationKey } from "../i18n/index.js";

const log = createLogger("progress-tracker");

// ─────────────────────────────────────────────────────────────────────────
// ProgressTracker
// ─────────────────────────────────────────────────────────────────────────

export interface ProgressTrackerOptions {
  client: WebClient;
  channelId: string;
  threadTs: string;
  userMessageTs?: string;
}

export class ProgressTracker {
  private client: WebClient;
  private channelId: string;
  private threadTs: string;
  private userMessageTs?: string;
  private statusMessageTs?: string;
  private startTime: number;
  private currentReaction?: string;

  // updateToolUse 쓰로틀링
  private static readonly THROTTLE_MS = 5000;
  private lastUpdateTime = 0;
  private pendingUpdate: string | null = null;
  private pendingUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: ProgressTrackerOptions) {
    this.client = options.client;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.userMessageTs = options.userMessageTs;
    this.startTime = Date.now();
  }

  /** 사용자 메시지에 👀 리액션 추가 (접수 확인) */
  async markReceived(): Promise<void> {
    try {
      await this.setReaction("eyes");
    } catch (error) {
      log.error("Failed to mark received", error);
    }
  }

  /** 작업 시작 — 👀→⚙️ 교체 + 상태 메시지 게시 */
  async markWorking(): Promise<void> {
    try {
      await this.swapReaction("eyes", "gear");
      await this.postStatusMessage(t("progress.working"));
    } catch (error) {
      log.error("Failed to mark working", error);
    }
  }

  /** 도구 사용 — 상태 메시지 갱신 (리액션 변경 없음, 5초 쓰로틀) */
  async updateToolUse(toolName: string): Promise<void> {
    try {
      const key = `progress.tool.${toolName}` as TranslationKey;
      const description = t(key) !== key ? t(key) : t("progress.tool.default");
      const elapsed = this.getElapsedText();
      const text = `:gear: ${description} (${elapsed})`;

      const now = Date.now();
      const timeSinceLastUpdate = now - this.lastUpdateTime;

      if (timeSinceLastUpdate >= ProgressTracker.THROTTLE_MS) {
        this.lastUpdateTime = now;
        this.clearPendingUpdate();
        await this.updateStatusMessage(text);
      } else {
        // 쓰로틀: 마지막 텍스트로 덮어쓰고 타이머 예약
        this.pendingUpdate = text;
        if (!this.pendingUpdateTimer) {
          const delay = ProgressTracker.THROTTLE_MS - timeSinceLastUpdate;
          this.pendingUpdateTimer = setTimeout(() => {
            if (this.disposed) return;
            this.flushPendingUpdate().catch((err) =>
              log.error("Failed to flush pending update", err)
            );
          }, delay);
        }
      }
    } catch (error) {
      log.error("Failed to update tool use", error);
    }
  }

  /** 작업 완료 — ⚙️→✅ 교체 + 상태 메시지 갱신 */
  async markCompleted(): Promise<void> {
    try {
      await this.flushPendingUpdate();
      await this.swapReaction("gear", "white_check_mark");
      const elapsed = this.getElapsedText();
      await this.updateStatusMessage(t("progress.completed", { elapsed }));
    } catch (error) {
      log.error("Failed to mark completed", error);
    }
  }

  /** 오류 — ⚙️→❌ 교체 + 상태 메시지 갱신 */
  async markError(errorMessage: string): Promise<void> {
    try {
      await this.flushPendingUpdate();
      await this.swapReaction(this.currentReaction ?? "gear", "x");
      await this.updateStatusMessage(t("progress.error", { error: errorMessage }));
    } catch (error) {
      log.error("Failed to mark error", error);
    }
  }

  /** 계획 승인 — ⚙️→👍 교체 + 상태 메시지 갱신 (구현 시작 전 전환 상태) */
  async markPlanApproved(): Promise<void> {
    try {
      await this.flushPendingUpdate();
      await this.swapReaction("gear", "thumbsup");
      await this.updateStatusMessage(t("progress.planApproved"));
    } catch (error) {
      log.error("Failed to mark plan approved", error);
    }
  }

  /** Autopilot 자동 응답 후 계속 진행 — 리액션 변경 없이 상태 메시지만 갱신 */
  async markAutopilotContinue(): Promise<void> {
    try {
      await this.flushPendingUpdate();
      const elapsed = this.getElapsedText();
      await this.updateStatusMessage(t("progress.autopilotContinue", { elapsed }));
    } catch (error) {
      log.error("Failed to mark autopilot continue", error);
    }
  }

  /** 질문 전송 — ⚙️→✋ 교체 + 상태 메시지 갱신 */
  async markAskUser(): Promise<void> {
    try {
      await this.flushPendingUpdate();
      await this.swapReaction("gear", "raised_hand");
      await this.updateStatusMessage(t("progress.askUser"));
    } catch (error) {
      log.error("Failed to mark ask user", error);
    }
  }

  /** 타이머 정리 — 인스턴스를 더 이상 사용하지 않을 때 호출 */
  dispose(): void {
    this.clearPendingUpdate();
    this.disposed = true;
  }

  // ─────────────────────────────────────────────────────────────────────
  // private helpers
  // ─────────────────────────────────────────────────────────────────────

  private async setReaction(emoji: string): Promise<void> {
    if (!this.userMessageTs) return;
    await addReaction(this.client, this.channelId, this.userMessageTs, emoji);
    this.currentReaction = emoji;
  }

  private async swapReaction(from: string, to: string): Promise<void> {
    if (!this.userMessageTs) return;
    // 현재 리액션이 from과 일치하면 제거
    if (this.currentReaction === from) {
      await removeReaction(this.client, this.channelId, this.userMessageTs, from);
    }
    try {
      await addReaction(this.client, this.channelId, this.userMessageTs, to);
      this.currentReaction = to;
    } catch (error) {
      log.error("Failed to add reaction during swap", { from, to, error });
      this.currentReaction = undefined;
    }
  }

  private async postStatusMessage(text: string): Promise<void> {
    const result = await postThreadMessage(
      this.client,
      this.channelId,
      text,
      this.threadTs
    );
    if (result.success && result.ts) {
      this.statusMessageTs = result.ts;
    }
  }

  private async updateStatusMessage(text: string): Promise<void> {
    if (!this.statusMessageTs) {
      // 상태 메시지가 아직 없으면 새로 게시
      await this.postStatusMessage(text);
      return;
    }

    try {
      await withRetry(() =>
        this.client.chat.update({
          channel: this.channelId,
          ts: this.statusMessageTs!,
          text,
        })
      );
    } catch (error) {
      log.error("Failed to update status message", { error });
    }
  }

  private async flushPendingUpdate(): Promise<void> {
    if (this.pendingUpdateTimer) {
      clearTimeout(this.pendingUpdateTimer);
      this.pendingUpdateTimer = null;
    }
    if (this.pendingUpdate) {
      const text = this.pendingUpdate;
      this.pendingUpdate = null;
      this.lastUpdateTime = Date.now();
      await this.updateStatusMessage(text);
    }
  }

  private clearPendingUpdate(): void {
    if (this.pendingUpdateTimer) {
      clearTimeout(this.pendingUpdateTimer);
      this.pendingUpdateTimer = null;
    }
    this.pendingUpdate = null;
  }

  private getElapsedText(): string {
    const elapsedMs = Date.now() - this.startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);

    if (totalSeconds < 1) {
      return t("progress.lessThanOneSecond");
    }

    if (totalSeconds < 60) {
      return t("progress.seconds", { n: totalSeconds });
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return t("progress.minutesSeconds", { m: minutes, s: seconds });
  }
}
