const mockLogInfo = vi.hoisted(() => vi.fn());
const mockLogDebug = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));

import {
  isSupportedFileType,
  isImageFile,
  isPdfFile,
  isTextFile,
  downloadSlackFiles,
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_TEXT_TYPES,
  TEXT_FILE_EXTENSIONS,
  MAX_IMAGES,
  MAX_PDFS,
  MAX_TEXT_FILES,
  MAX_IMAGE_SIZE,
  MAX_PDF_SIZE,
  MAX_TEXT_SIZE,
} from "../utils/slack-file-downloader.js";
import type { SlackFileInfo } from "../types/index.js";

// Helper to create mock SlackFileInfo
function createMockFile(overrides: Partial<SlackFileInfo> = {}): SlackFileInfo {
  return {
    id: "F123",
    name: "test.txt",
    mimetype: "text/plain",
    filetype: "txt",
    url_private: "https://files.slack.com/test",
    url_private_download: "https://files.slack.com/test/download",
    size: 1000,
    ...overrides,
  };
}

describe("slack-file-downloader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isImageFile", () => {
    it("returns true for supported image mimetypes", () => {
      for (const mimetype of SUPPORTED_IMAGE_TYPES) {
        expect(isImageFile(mimetype)).toBe(true);
      }
    });

    it("returns false for non-image mimetypes", () => {
      expect(isImageFile("application/pdf")).toBe(false);
      expect(isImageFile("text/plain")).toBe(false);
      expect(isImageFile("video/mp4")).toBe(false);
    });
  });

  describe("isPdfFile", () => {
    it("returns true for PDF mimetype", () => {
      expect(isPdfFile("application/pdf")).toBe(true);
      expect(isPdfFile("application/octet-stream", "doc.pdf")).toBe(true);
    });

    it("returns false for non-PDF mimetypes", () => {
      expect(isPdfFile("image/png")).toBe(false);
      expect(isPdfFile("text/plain")).toBe(false);
    });
  });

  describe("isTextFile", () => {
    it("returns true for supported text mimetypes", () => {
      for (const mimetype of SUPPORTED_TEXT_TYPES) {
        expect(isTextFile(mimetype, "test.txt")).toBe(true);
      }
    });

    it("returns true for code file extensions with octet-stream", () => {
      for (const ext of TEXT_FILE_EXTENSIONS) {
        expect(isTextFile("application/octet-stream", `file${ext}`)).toBe(true);
      }
    });

    it("returns false for unknown types", () => {
      expect(isTextFile("video/mp4", "video.mp4")).toBe(false);
      expect(isTextFile("application/octet-stream", "file.xyz")).toBe(false);
    });

    it("handles files without extensions", () => {
      // Makefile has no extension, should return false
      expect(isTextFile("application/octet-stream", "Makefile")).toBe(false);
    });

    it("handles hidden files (dotfiles) correctly", () => {
      // .gitignore is in TEXT_FILE_EXTENSIONS
      expect(isTextFile("application/octet-stream", ".gitignore")).toBe(true);
      expect(isTextFile("application/octet-stream", ".dockerignore")).toBe(true);
      // .unknownfile is not in the list
      expect(isTextFile("application/octet-stream", ".unknownfile")).toBe(false);
    });
  });

  describe("isSupportedFileType", () => {
    it("returns true for image files", () => {
      const file = createMockFile({ mimetype: "image/png", name: "photo.png" });
      expect(isSupportedFileType(file)).toBe(true);
    });

    it("returns true for PDF files", () => {
      const file = createMockFile({ mimetype: "application/pdf", name: "doc.pdf" });
      expect(isSupportedFileType(file)).toBe(true);
    });

    it("returns true for PDF files by extension", () => {
      const file = createMockFile({ mimetype: "application/octet-stream", name: "doc.pdf" });
      expect(isSupportedFileType(file)).toBe(true);
    });

    it("returns true for text files", () => {
      const file = createMockFile({ mimetype: "text/plain", name: "readme.txt" });
      expect(isSupportedFileType(file)).toBe(true);
    });

    it("returns true for code files by extension", () => {
      const file = createMockFile({ mimetype: "application/octet-stream", name: "app.ts" });
      expect(isSupportedFileType(file)).toBe(true);
    });

    it("returns false for unsupported types", () => {
      const file = createMockFile({ mimetype: "video/mp4", name: "video.mp4" });
      expect(isSupportedFileType(file)).toBe(false);
    });

    it("handles files without extensions", () => {
      const file = createMockFile({ mimetype: "application/octet-stream", name: "Makefile" });
      expect(isSupportedFileType(file)).toBe(false);
    });
  });

  describe("downloadSlackFiles", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", mockFetch);
      mockFetch.mockReset();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("skips files without download URL", async () => {
      const file = createMockFile({ url_private_download: "" });

      const result = await downloadSlackFiles([file], "xoxb-token");

      expect(result.success).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe("No download URL available");
    });

    it("skips unsupported file types", async () => {
      const file = createMockFile({ mimetype: "video/mp4", name: "video.mp4" });

      const result = await downloadSlackFiles([file], "xoxb-token");

      expect(result.success).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("Unsupported file type");
    });

    it("enforces image count limit", async () => {
      const files = Array.from({ length: MAX_IMAGES + 5 }, (_, i) =>
        createMockFile({
          id: `F${i}`,
          name: `image${i}.png`,
          mimetype: "image/png",
          size: 1000,
        })
      );

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const pngBuffer = pngData.buffer.slice(pngData.byteOffset, pngData.byteOffset + pngData.byteLength);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(pngBuffer),
        headers: new Headers({ "content-type": "image/png" }),
      });

      const result = await downloadSlackFiles(files, "xoxb-token");

      expect(result.success).toHaveLength(MAX_IMAGES);
      expect(result.skipped).toHaveLength(5);
      expect(result.skipped[0].reason).toContain("Image limit exceeded");
    });

    it("enforces PDF count limit", async () => {
      const files = Array.from({ length: MAX_PDFS + 3 }, (_, i) =>
        createMockFile({
          id: `F${i}`,
          name: `doc${i}.pdf`,
          mimetype: "application/pdf",
          size: 1000,
        })
      );

      const pdfData = Buffer.from("%PDF-1.4");
      const pdfBuffer = pdfData.buffer.slice(pdfData.byteOffset, pdfData.byteOffset + pdfData.byteLength);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(pdfBuffer),
        headers: new Headers({ "content-type": "application/pdf" }),
      });

      const result = await downloadSlackFiles(files, "xoxb-token");

      expect(result.success).toHaveLength(MAX_PDFS);
      expect(result.skipped).toHaveLength(3);
      expect(result.skipped[0].reason).toContain("PDF limit exceeded");
    });

    it("enforces text file count limit", async () => {
      const files = Array.from({ length: MAX_TEXT_FILES + 3 }, (_, i) =>
        createMockFile({
          id: `F${i}`,
          name: `file${i}.ts`,
          mimetype: "application/octet-stream",
          size: 1000,
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        headers: new Headers({ "content-type": "application/octet-stream" }),
      });

      const result = await downloadSlackFiles(files, "xoxb-token");

      expect(result.success).toHaveLength(MAX_TEXT_FILES);
      expect(result.skipped).toHaveLength(3);
      expect(result.skipped[0].reason).toContain("Text file limit exceeded");
    });

    it("skips files exceeding size limit", async () => {
      const file = createMockFile({
        mimetype: "image/png",
        name: "large.png",
        size: MAX_IMAGE_SIZE + 1,
      });

      const result = await downloadSlackFiles([file], "xoxb-token");

      expect(result.success).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain("File too large");
    });

    it("downloads file successfully", async () => {
      const file = createMockFile({
        mimetype: "text/plain",
        name: "test.txt",
        size: 100,
      });

      const testData = new TextEncoder().encode("Hello, World!");
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(testData.buffer),
        headers: new Headers({
          "content-type": "text/plain",
          "content-length": "13",
        }),
      });

      const result = await downloadSlackFiles([file], "xoxb-token");

      expect(result.success).toHaveLength(1);
      expect(result.success[0].name).toBe("test.txt");
      expect(result.success[0].data.toString()).toBe("Hello, World!");
      expect(mockFetch).toHaveBeenCalledWith(
        file.url_private_download,
        expect.objectContaining({
          headers: { Authorization: "Bearer xoxb-token" },
        })
      );
    });

    it("handles download failure", async () => {
      const file = createMockFile({
        mimetype: "text/plain",
        name: "test.txt",
        size: 100,
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Access denied"),
        headers: new Headers(),
      });

      const result = await downloadSlackFiles([file], "xoxb-token");

      expect(result.success).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain("403");
    });

    it("retries on 5xx errors", async () => {
      const file = createMockFile({
        mimetype: "text/plain",
        name: "test.txt",
        size: 100,
      });

      const testData = new TextEncoder().encode("Success after retry");

      // First call fails with 500, second succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: () => Promise.resolve("Server error"),
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(testData.buffer),
          headers: new Headers({ "content-type": "text/plain" }),
        });

      const result = await downloadSlackFiles([file], "xoxb-token");

      expect(result.success).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("handles mixed file types correctly", async () => {
      const files = [
        createMockFile({ id: "F1", name: "image.png", mimetype: "image/png", size: 1000 }),
        createMockFile({ id: "F2", name: "doc.pdf", mimetype: "application/pdf", size: 1000 }),
        createMockFile({ id: "F3", name: "code.ts", mimetype: "application/octet-stream", size: 1000 }),
        createMockFile({ id: "F4", name: "video.mp4", mimetype: "video/mp4", size: 1000 }),
      ];

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const pngBuffer = pngData.buffer.slice(pngData.byteOffset, pngData.byteOffset + pngData.byteLength);
      const pdfData = Buffer.from("%PDF-1.4");
      const pdfBuffer = pdfData.buffer.slice(pdfData.byteOffset, pdfData.byteOffset + pdfData.byteLength);
      const textData = new TextEncoder().encode("const x = 1;");
      const textBuffer = textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(pngBuffer),
          headers: new Headers({ "content-type": "image/png" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(pdfBuffer),
          headers: new Headers({ "content-type": "application/pdf" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(textBuffer),
          headers: new Headers({ "content-type": "application/octet-stream" }),
        });

      const result = await downloadSlackFiles(files, "xoxb-token");

      expect(result.success).toHaveLength(3); // image, pdf, ts
      expect(result.skipped).toHaveLength(1); // video
    });
  });
});
