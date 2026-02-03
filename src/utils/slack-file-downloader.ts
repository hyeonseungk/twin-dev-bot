import { createLogger } from "../core/logger.js";
import type { SlackFileInfo } from "../types/index.js";

const log = createLogger("slack-file-downloader");

// 상수 정의 (Claude API 제한 기준)
export const MAX_IMAGE_SIZE = 3.75 * 1024 * 1024; // 3.75MB (Claude 이미지 제한)
export const MAX_PDF_SIZE = 32 * 1024 * 1024;     // 32MB (Claude PDF 제한)
export const MAX_TEXT_SIZE = 1 * 1024 * 1024;     // 1MB (텍스트 파일 적정 크기)
export const MAX_IMAGES = 20;                      // Claude 이미지 개수 제한
export const MAX_PDFS = 5;                         // Claude PDF 개수 제한
export const DOWNLOAD_TIMEOUT = 30000;             // 30초

// 지원하는 파일 타입
export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export const SUPPORTED_DOCUMENT_TYPES = ["application/pdf"];

export const SUPPORTED_TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/xml",
  "text/xml",
];

// 코드 파일 확장자 (mimetype이 application/octet-stream인 경우 확장자로 판단)
export const TEXT_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".md",
  ".txt",
  ".log",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
];

export interface DownloadedFile {
  name: string;
  mimetype: string;
  data: Buffer;
}

export interface DownloadResult {
  success: DownloadedFile[];
  failed: Array<{ file: SlackFileInfo; error: string }>;
  skipped: Array<{ file: SlackFileInfo; reason: string }>;
}

/**
 * 파일 타입이 지원되는지 확인
 */
export function isSupportedFileType(file: SlackFileInfo): boolean {
  const { mimetype, name } = file;

  // 이미지
  if (SUPPORTED_IMAGE_TYPES.includes(mimetype)) return true;

  // PDF
  if (SUPPORTED_DOCUMENT_TYPES.includes(mimetype)) return true;

  // 텍스트
  if (SUPPORTED_TEXT_TYPES.includes(mimetype)) return true;

  // application/octet-stream이나 mimetype이 불명확한 경우 확장자로 판단
  const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.includes(ext)) return true;

  return false;
}

/**
 * 파일이 이미지인지 확인
 */
export function isImageFile(mimetype: string): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(mimetype);
}

/**
 * 파일이 PDF인지 확인
 */
export function isPdfFile(mimetype: string): boolean {
  return SUPPORTED_DOCUMENT_TYPES.includes(mimetype);
}

/**
 * 파일이 텍스트 기반인지 확인
 */
export function isTextFile(file: SlackFileInfo): boolean {
  const { mimetype, name } = file;

  if (SUPPORTED_TEXT_TYPES.includes(mimetype)) return true;

  const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

/**
 * 단일 파일 다운로드
 */
async function downloadFile(
  file: SlackFileInfo,
  botToken: string
): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

  log.info("Starting file download", {
    name: file.name,
    url: file.url_private_download?.slice(0, 100) + "...",
    hasToken: !!botToken,
    tokenPrefix: botToken?.slice(0, 10) + "...",
  });

  try {
    const response = await fetch(file.url_private_download, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
      signal: controller.signal,
    });

    log.info("Download response received", {
      name: file.name,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unable to read body)");
      log.error("Download failed with non-OK status", {
        name: file.name,
        status: response.status,
        body: body.slice(0, 500),
      });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    log.info("File content downloaded", {
      name: file.name,
      bytes: arrayBuffer.byteLength,
    });
    return Buffer.from(arrayBuffer);
  } catch (error) {
    log.error("Download error", {
      name: file.name,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 파일 타입에 따른 최대 크기 반환
 */
function getMaxSizeForFile(file: SlackFileInfo): number {
  if (isImageFile(file.mimetype)) return MAX_IMAGE_SIZE;
  if (isPdfFile(file.mimetype)) return MAX_PDF_SIZE;
  return MAX_TEXT_SIZE;
}

/**
 * Slack 파일들을 다운로드
 */
export async function downloadSlackFiles(
  files: SlackFileInfo[],
  botToken: string
): Promise<DownloadResult> {
  const result: DownloadResult = {
    success: [],
    failed: [],
    skipped: [],
  };

  // 타입별 카운터
  let imageCount = 0;
  let pdfCount = 0;

  for (const file of files) {
    // 타입 검사 (먼저 수행)
    if (!isSupportedFileType(file)) {
      result.skipped.push({
        file,
        reason: `Unsupported file type: ${file.mimetype}`,
      });
      log.info("Skipping unsupported file type", {
        name: file.name,
        mimetype: file.mimetype,
      });
      continue;
    }

    // 타입별 개수 제한 검사
    if (isImageFile(file.mimetype)) {
      if (imageCount >= MAX_IMAGES) {
        result.skipped.push({
          file,
          reason: `Image limit exceeded (max ${MAX_IMAGES})`,
        });
        log.info("Skipping image due to count limit", { name: file.name });
        continue;
      }
      imageCount++;
    } else if (isPdfFile(file.mimetype)) {
      if (pdfCount >= MAX_PDFS) {
        result.skipped.push({
          file,
          reason: `PDF limit exceeded (max ${MAX_PDFS})`,
        });
        log.info("Skipping PDF due to count limit", { name: file.name });
        continue;
      }
      pdfCount++;
    }

    // 타입별 크기 제한 검사
    const maxSize = getMaxSizeForFile(file);
    if (file.size > maxSize) {
      result.skipped.push({
        file,
        reason: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(1)}MB)`,
      });
      log.info("Skipping large file", { name: file.name, size: file.size, maxSize });
      continue;
    }

    // 다운로드 시도
    try {
      log.debug("Downloading file", { name: file.name, size: file.size });
      const data = await downloadFile(file, botToken);

      result.success.push({
        name: file.name,
        mimetype: file.mimetype,
        data,
      });

      log.info("File downloaded successfully", {
        name: file.name,
        size: data.length,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.failed.push({
        file,
        error: errorMsg,
      });
      log.error("Failed to download file", {
        name: file.name,
        error: errorMsg,
      });
    }
  }

  log.info("File download complete", {
    success: result.success.length,
    failed: result.failed.length,
    skipped: result.skipped.length,
  });

  return result;
}
