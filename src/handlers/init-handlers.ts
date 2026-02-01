import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import { existsSync } from "fs";
import { basename, join } from "path";
import { createLogger } from "../core/logger.js";
import { setChannelDir } from "../stores/channel-store.js";
import { config } from "../core/config.js";
import { expandTilde } from "../core/platform.js";
import { t } from "../i18n/index.js";
import type { InitDirSelectValue, InitCustomDirModalMetadata } from "../types/index.js";

const log = createLogger("init-handlers");

export function registerInitHandlers(app: App): void {
  log.info("Registering init handlers");

  // 디렉토리 선택 버튼 핸들러
  app.action<BlockAction<ButtonAction>>(
    /^init_select_dir_\d+$/,
    async ({ ack, body, client, action }) => {
      await ack();
      try {
        if (!action.value) return;

        let selected: InitDirSelectValue;
        try {
          selected = JSON.parse(action.value);
        } catch {
          log.error("Failed to parse init_select_dir value", { value: action.value?.slice(0, 100) });
          return;
        }

        const channelId = body.channel?.id;
        const messageTs = (body.message as Record<string, unknown> | undefined)?.ts as string | undefined;
        if (!channelId || !messageTs) {
          log.error("Missing channel or message ts in init_select_dir action");
          return;
        }

        const baseDir = config.baseDir;
        const directory = join(baseDir, selected.dirName);
        const projectName = basename(selected.dirName);

        // 디렉토리 존재 확인
        if (!existsSync(directory)) {
          try {
            await client.chat.postEphemeral({
              channel: channelId,
              user: body.user.id,
              text: t("command.initInvalidDir", { directory }),
            });
          } catch (e) {
            log.error("Failed to send dir not found notice", e);
          }
          return;
        }

        // 채널 매핑 저장
        setChannelDir(channelId, { directory, projectName });

        // 원본 메시지 업데이트 (버튼 제거, 확인 메시지로)
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: t("command.initSuccess", { dirName: projectName }),
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: t("command.initSuccess", { dirName: projectName }) },
              },
            ],
          });
        } catch (e) {
          log.error("Failed to update init message", e);
        }

        log.info("Channel directory set via button", { channelId, projectName, directory });
      } catch (error) {
        log.error("Error handling init_select_dir action", error);
      }
    }
  );

  // 직접 입력 버튼 핸들러
  app.action<BlockAction<ButtonAction>>(
    "init_custom_input",
    async ({ ack, body, client }) => {
      await ack();
      try {
        const channelId = body.channel?.id;
        const messageTs = (body.message as Record<string, unknown> | undefined)?.ts as string | undefined;
        if (!channelId || !messageTs) {
          log.error("Missing channel or message ts in init_custom_input action");
          return;
        }

        const metadata: InitCustomDirModalMetadata = {
          channelId,
          originalMessageTs: messageTs,
        };

        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal",
            callback_id: "init_custom_dir_modal",
            private_metadata: JSON.stringify(metadata),
            title: { type: "plain_text", text: t("command.initModalTitle") },
            submit: { type: "plain_text", text: t("modal.submit") },
            close: { type: "plain_text", text: t("modal.cancel") },
            blocks: [
              {
                type: "input",
                block_id: "dir_block",
                label: { type: "plain_text", text: t("command.initModalLabel") },
                element: {
                  type: "plain_text_input",
                  action_id: "dir_input",
                  placeholder: { type: "plain_text", text: t("command.initModalPlaceholder") },
                },
              },
            ],
          },
        });

        log.debug("Init custom dir modal opened", { channelId });
      } catch (error) {
        log.error("Error handling init_custom_input action", error);
      }
    }
  );

  // 직접 입력 모달 제출 핸들러
  app.view("init_custom_dir_modal", async ({ ack, view, client }) => {
    let metadata: InitCustomDirModalMetadata | undefined;
    try {
      try {
        metadata = JSON.parse(view.private_metadata);
      } catch {
        log.error("Failed to parse init modal metadata", { metadata: view.private_metadata?.slice(0, 100) });
        await ack();
        return;
      }

      if (!metadata) {
        await ack();
        return;
      }

      const rawPath = view.state.values.dir_block.dir_input.value?.trim() || "";

      if (!rawPath) {
        await ack({
          response_action: "errors",
          errors: { dir_block: t("command.initModalDirNotExist") },
        } as never);
        return;
      }

      // 경로 결정: 절대 경로면 그대로, ~로 시작하면 확장, 상대 경로면 baseDir 기준
      const baseDir = config.baseDir;
      let directory: string;
      if (rawPath.startsWith("/")) {
        directory = rawPath;
      } else if (rawPath.startsWith("~")) {
        directory = expandTilde(rawPath);
      } else {
        directory = join(baseDir, rawPath);
      }

      if (!existsSync(directory)) {
        await ack({
          response_action: "errors",
          errors: { dir_block: t("command.initModalDirNotExist") },
        } as never);
        return;
      }

      await ack();

      const projectName = basename(directory);
      setChannelDir(metadata.channelId, { directory, projectName });

      // 원본 메시지 업데이트
      try {
        await client.chat.update({
          channel: metadata.channelId,
          ts: metadata.originalMessageTs,
          text: t("command.initSuccess", { dirName: projectName }),
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: t("command.initSuccess", { dirName: projectName }) },
            },
          ],
        });
      } catch (e) {
        log.error("Failed to update init message after modal submit", e);
      }

      log.info("Channel directory set via custom input", {
        channelId: metadata.channelId,
        projectName,
        directory,
      });
    } catch (error) {
      log.error("Error handling init_custom_dir_modal submission", error);
    }
  });
}
