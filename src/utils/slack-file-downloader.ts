import { createLogger } from "../core/logger.js";
import type { SlackFileInfo } from "../types/index.js";

const log = createLogger("slack-file-downloader");

// 상수 정의 (Claude API 제한 기준)
export const MAX_IMAGE_SIZE = 3.75 * 1024 * 1024; // 3.75MB (Claude 이미지 제한)
export const MAX_PDF_SIZE = 32 * 1024 * 1024;     // 32MB (Claude PDF 제한)
export const MAX_TEXT_SIZE = 1 * 1024 * 1024;     // 1MB (텍스트 파일 적정 크기)
export const MAX_IMAGES = 20;                      // Claude 이미지 개수 제한
export const MAX_PDFS = 5;                         // Claude PDF 개수 제한
export const MAX_TEXT_FILES = 20;                  // 텍스트 파일 개수 제한
export const DOWNLOAD_TIMEOUT = 30000;             // 30초
export const MAX_RETRIES = 3;                      // 최대 재시도 횟수
export const INITIAL_RETRY_DELAY = 1000;           // 첫 재시도 대기 시간 (ms)

// 지원하는 파일 타입
export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
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

const PDF_HEADER = "%PDF-";
const MAX_PDF_HEADER_SCAN_BYTES = 1024;
const HTML_MARKERS = ["<!doctype", "<html", "<head", "<body"];

const IMAGE_MAGIC_BYTES: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/jpg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46],
  "image/webp": [0x52, 0x49, 0x46, 0x46], // RIFF header
};

/**
 * 파일명에서 확장자 추출 (없으면 빈 문자열 반환)
 */
function getFileExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf(".");
  if (lastDotIndex === -1 || lastDotIndex === 0) {
    // 점이 없거나 숨김 파일(.gitignore 등)인 경우
    // 숨김 파일은 전체 이름을 확장자로 취급
    if (filename.startsWith(".")) {
      return filename.toLowerCase();
    }
    return "";
  }
  return filename.substring(lastDotIndex).toLowerCase();
}

function isHtmlLike(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const snippet = buffer.subarray(0, 256).toString("utf8").toLowerCase();
  return HTML_MARKERS.some((marker) => snippet.includes(marker));
}

function hasMagicBytes(buffer: Buffer, magic: number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, index) => buffer[index] === byte);
}

function validateImageData(buffer: Buffer, mimetype: string): { valid: boolean; reason?: string } {
  if (buffer.length === 0) return { valid: false, reason: "Downloaded file is empty" };
  if (isHtmlLike(buffer)) return { valid: false, reason: "Downloaded file looks like HTML (auth error?)" };

  if (mimetype === "image/webp") {
    const riffOk = hasMagicBytes(buffer, IMAGE_MAGIC_BYTES["image/webp"]);
    const webpOk = buffer.subarray(8, 12).toString("ascii") === "WEBP";
    if (riffOk && webpOk) return { valid: true };
    return { valid: false, reason: "Invalid WEBP header" };
  }

  const magic = IMAGE_MAGIC_BYTES[mimetype];
  if (!magic) return { valid: true };
  if (hasMagicBytes(buffer, magic)) return { valid: true };
  return { valid: false, reason: "Invalid image header" };
}

function validatePdfData(buffer: Buffer): { valid: boolean; reason?: string } {
  if (buffer.length === 0) return { valid: false, reason: "Downloaded file is empty" };
  if (isHtmlLike(buffer)) return { valid: false, reason: "Downloaded file looks like HTML (auth error?)" };

  const scan = buffer.subarray(0, Math.min(buffer.length, MAX_PDF_HEADER_SCAN_BYTES));
  const headerIndex = scan.indexOf(PDF_HEADER);
  if (headerIndex === -1) {
    return { valid: false, reason: "PDF header not found" };
  }
  return { valid: true };
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

  // PDF 확장자 허용 (mimetype이 octet-stream 등인 경우)
  if (getFileExtension(name) === ".pdf") return true;

  // application/octet-stream이나 mimetype이 불명확한 경우 확장자로 판단
  const ext = getFileExtension(name);
  if (ext && TEXT_FILE_EXTENSIONS.includes(ext)) return true;

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
export function isPdfFile(mimetype: string, filename?: string): boolean {
  if (SUPPORTED_DOCUMENT_TYPES.includes(mimetype)) return true;
  if (filename) {
    return getFileExtension(filename) === ".pdf";
  }
  return false;
}

/**
 * 파일이 텍스트 기반인지 확인
 * @param mimetype - 파일의 MIME 타입
 * @param filename - 파일명 (확장자 판단용)
 */
export function isTextFile(mimetype: string, filename: string): boolean {
  if (SUPPORTED_TEXT_TYPES.includes(mimetype)) return true;

  const ext = getFileExtension(filename);
  return ext !== "" && TEXT_FILE_EXTENSIONS.includes(ext);
}

/**
 * 지연 함수 (재시도 대기용)
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 재시도 가능한 에러인지 확인
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // 네트워크 오류, 타임아웃, 서버 오류 (5xx)
    const message = error.message.toLowerCase();
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("aborted") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("http 5")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 단일 파일 다운로드 (재시도 로직 포함)
 */
async function downloadFile(
  file: SlackFileInfo,
  botToken: string
): Promise<Buffer> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      log.info("Retrying file download", {
        name: file.name,
        attempt,
        delayMs,
      });
      await delay(delayMs);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

    try {
      log.info("Starting file download", {
        name: file.name,
        url: file.url_private_download?.slice(0, 100) + "...",
        attempt: attempt > 0 ? attempt : undefined,
      });

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
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);

        // 5xx 에러는 재시도
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          lastError = error;
          continue;
        }
        throw error;
      }

      const arrayBuffer = await response.arrayBuffer();
      log.info("File content downloaded", {
        name: file.name,
        bytes: arrayBuffer.byteLength,
      });
      return Buffer.from(arrayBuffer);
    } catch (error) {
      clearTimeout(timeoutId);

      const err = error instanceof Error ? error : new Error(String(error));
      log.error("Download error", {
        name: file.name,
        error: err.message,
        errorType: err.constructor.name,
        attempt,
      });

      // 재시도 가능한 에러이고 재시도 횟수가 남았으면 계속
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        lastError = err;
        continue;
      }

      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 모든 재시도 실패
  throw lastError || new Error("Download failed after all retries");
}

/**
 * 파일 타입에 따른 최대 크기 반환
 */
function getMaxSizeForFile(file: SlackFileInfo): number {
  if (isImageFile(file.mimetype)) return MAX_IMAGE_SIZE;
  if (isPdfFile(file.mimetype, file.name)) return MAX_PDF_SIZE;
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
  let textCount = 0;

  for (const file of files) {
    // url_private_download 존재 여부 검증
    if (!file.url_private_download) {
      result.skipped.push({
        file,
        reason: "No download URL available",
      });
      log.info("Skipping file without download URL", {
        name: file.name,
        mimetype: file.mimetype,
      });
      continue;
    }

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
    } else if (isPdfFile(file.mimetype, file.name)) {
      if (pdfCount >= MAX_PDFS) {
        result.skipped.push({
          file,
          reason: `PDF limit exceeded (max ${MAX_PDFS})`,
        });
        log.info("Skipping PDF due to count limit", { name: file.name });
        continue;
      }
      pdfCount++;
    } else if (isTextFile(file.mimetype, file.name)) {
      if (textCount >= MAX_TEXT_FILES) {
        result.skipped.push({
          file,
          reason: `Text file limit exceeded (max ${MAX_TEXT_FILES})`,
        });
        log.info("Skipping text file due to count limit", { name: file.name });
        continue;
      }
      textCount++;
    }

    // 타입별 크기 제한 검사 (메타데이터 기준)
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

      // 다운로드된 실제 크기 재검증
      if (data.length > maxSize) {
        result.skipped.push({
          file,
          reason: `File too large after download (${(data.length / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(1)}MB)`,
        });
        log.info("Skipping file due to downloaded size", { name: file.name, size: data.length, maxSize });
        continue;
      }

      // 콘텐츠 검증 (HTML/손상된 파일 방지)
      let validation: { valid: boolean; reason?: string } = { valid: true };
      if (isImageFile(file.mimetype)) {
        validation = validateImageData(data, file.mimetype);
      } else if (isPdfFile(file.mimetype, file.name)) {
        validation = validatePdfData(data);
      }

      if (!validation.valid) {
        result.failed.push({
          file,
          error: validation.reason ?? "Downloaded file is invalid",
        });
        log.error("Downloaded file failed validation", {
          name: file.name,
          mimetype: file.mimetype,
          reason: validation.reason,
        });
        continue;
      }

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
