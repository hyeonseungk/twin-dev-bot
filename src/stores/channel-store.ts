/**
 * Channel Store
 *
 * 슬랙 채널과 작업 디렉토리의 매핑을 관리합니다.
 * /twindevbot init으로 설정된 채널별 작업 디렉토리를 영속적으로 저장합니다.
 *
 * 키: channelId (Slack 채널 ID)
 * 값: { directory, projectName }
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { createLogger } from "../core/logger.js";
import { CHANNELS_FILE } from "../core/paths.js";

const log = createLogger("channel-store");

export interface ChannelDir {
  directory: string;
  projectName: string;
}

interface SerializedChannelDir {
  channelId: string;
  directory: string;
  projectName: string;
}

interface ChannelsFile {
  version: number;
  channels: SerializedChannelDir[];
}

const channels = new Map<string, ChannelDir>();

function loadFromFile(): void {
  try {
    if (!existsSync(CHANNELS_FILE)) {
      log.info("No channels file found, starting fresh");
      return;
    }

    const content = readFileSync(CHANNELS_FILE, "utf-8");

    let data: ChannelsFile;
    try {
      data = JSON.parse(content);
    } catch (parseError) {
      log.error("Channels file is corrupted, starting fresh", { parseError });
      return;
    }

    if (!data.channels || !Array.isArray(data.channels)) {
      log.error("Channels file has invalid structure, starting fresh");
      return;
    }

    let loadedCount = 0;
    for (const c of data.channels) {
      try {
        channels.set(c.channelId, {
          directory: c.directory,
          projectName: c.projectName,
        });
        loadedCount++;
      } catch (entryError) {
        log.warn("Skipping invalid channel entry", { entry: c, error: entryError });
      }
    }

    log.info("Channels loaded from file", { count: loadedCount, total: data.channels.length });
  } catch (error) {
    log.error("Failed to load channels from file", { error });
  }
}

function saveToFile(): void {
  try {
    const serialized: SerializedChannelDir[] = Array.from(channels.entries()).map(
      ([channelId, c]) => ({
        channelId,
        directory: c.directory,
        projectName: c.projectName,
      })
    );

    const data: ChannelsFile = {
      version: 1,
      channels: serialized,
    };

    const tmpFile = CHANNELS_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    renameSync(tmpFile, CHANNELS_FILE);
    log.debug("Channels saved to file", { count: serialized.length });
  } catch (error) {
    log.error("Failed to save channels to file", { error });
  }
}

// 모듈 로드 시 파일에서 복원
loadFromFile();

export function setChannelDir(channelId: string, dir: ChannelDir): void {
  channels.set(channelId, dir);
  log.info("Channel directory set", {
    channelId,
    projectName: dir.projectName,
    directory: dir.directory,
  });
  saveToFile();
}

export function getChannelDir(channelId: string): ChannelDir | undefined {
  return channels.get(channelId);
}

export function removeChannelDir(channelId: string): void {
  channels.delete(channelId);
  log.debug("Channel directory removed", { channelId });
  saveToFile();
}
