import { createLogger } from "../core/logger.js";
import {
  isImageFile,
  isPdfFile,
  isTextFile,
  type DownloadedFile,
} from "./slack-file-downloader.js";
import type { SlackFileInfo } from "../types/index.js";

const log = createLogger("claude-content-builder");

// Claude API content block 타입
export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ClaudeDocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeDocumentBlock;

// Stream-JSON 입력 메시지 타입
export interface ClaudeStreamMessage {
  type: "user";
  message: {
    role: "user";
    content: ClaudeContentBlock[];
  };
}

/**
 * 다운로드된 파일을 Claude content block으로 변환
 */
function fileToContentBlock(file: DownloadedFile): ClaudeContentBlock | null {
  // 이미지 파일
  if (isImageFile(file.mimetype)) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: file.mimetype,
        data: file.data.toString("base64"),
      },
    };
  }

  // PDF 파일
  if (isPdfFile(file.mimetype)) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: file.mimetype,
        data: file.data.toString("base64"),
      },
    };
  }

  // 텍스트 파일 - SlackFileInfo 형식으로 변환하여 isTextFile 호출
  const mockFileInfo: SlackFileInfo = {
    id: "",
    name: file.name,
    mimetype: file.mimetype,
    filetype: "",
    url_private: "",
    url_private_download: "",
    size: file.data.length,
  };

  if (isTextFile(mockFileInfo)) {
    try {
      const textContent = file.data.toString("utf-8");
      return {
        type: "text",
        text: `--- File: ${file.name} ---\n${textContent}\n--- End of ${file.name} ---`,
      };
    } catch {
      log.warn("Failed to decode text file as UTF-8", { name: file.name });
      return null;
    }
  }

  log.warn("Unknown file type, skipping", {
    name: file.name,
    mimetype: file.mimetype,
  });
  return null;
}

/**
 * 텍스트와 파일들로부터 Claude content block 배열 생성
 */
export function buildContentBlocks(
  text: string | undefined,
  files: DownloadedFile[]
): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = [];

  // 텍스트가 있으면 먼저 추가
  if (text && text.trim()) {
    blocks.push({
      type: "text",
      text: text.trim(),
    });
  }

  // 파일들을 content block으로 변환
  for (const file of files) {
    const block = fileToContentBlock(file);
    if (block) {
      blocks.push(block);
    }
  }

  // 아무 것도 없으면 기본 메시지 추가
  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      text: "Please analyze the attached file(s).",
    });
  }

  log.debug("Built content blocks", {
    textBlocks: blocks.filter((b) => b.type === "text").length,
    imageBlocks: blocks.filter((b) => b.type === "image").length,
    documentBlocks: blocks.filter((b) => b.type === "document").length,
  });

  return blocks;
}

/**
 * Stream-JSON 형식의 메시지 문자열 생성
 */
export function buildStreamJsonMessage(
  text: string | undefined,
  files: DownloadedFile[]
): string {
  const content = buildContentBlocks(text, files);

  const message: ClaudeStreamMessage = {
    type: "user",
    message: {
      role: "user",
      content,
    },
  };

  return JSON.stringify(message);
}
