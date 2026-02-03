const mockLogDebug = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: mockLogDebug,
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
  }),
}));

import {
  buildContentBlocks,
  buildStreamJsonMessage,
  type ClaudeTextBlock,
  type ClaudeImageBlock,
  type ClaudeDocumentBlock,
} from "../utils/claude-content-builder.js";
import type { DownloadedFile } from "../utils/slack-file-downloader.js";

// Helper to create mock DownloadedFile
function createMockDownloadedFile(overrides: Partial<DownloadedFile> = {}): DownloadedFile {
  return {
    name: "test.txt",
    mimetype: "text/plain",
    data: Buffer.from("Hello, World!"),
    ...overrides,
  };
}

describe("claude-content-builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildContentBlocks", () => {
    it("creates text block from text input", () => {
      const blocks = buildContentBlocks("Hello, Claude!", []);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect((blocks[0] as ClaudeTextBlock).text).toBe("Hello, Claude!");
    });

    it("trims whitespace from text", () => {
      const blocks = buildContentBlocks("  Hello!  ", []);

      expect(blocks).toHaveLength(1);
      expect((blocks[0] as ClaudeTextBlock).text).toBe("Hello!");
    });

    it("creates image block for image files", () => {
      const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const file = createMockDownloadedFile({
        name: "photo.png",
        mimetype: "image/png",
        data: imageData,
      });

      const blocks = buildContentBlocks(undefined, [file]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("image");
      const imageBlock = blocks[0] as ClaudeImageBlock;
      expect(imageBlock.source.type).toBe("base64");
      expect(imageBlock.source.media_type).toBe("image/png");
      expect(imageBlock.source.data).toBe(imageData.toString("base64"));
    });

    it("creates document block for PDF files", () => {
      const pdfData = Buffer.from("%PDF-1.4");
      const file = createMockDownloadedFile({
        name: "doc.pdf",
        mimetype: "application/pdf",
        data: pdfData,
      });

      const blocks = buildContentBlocks(undefined, [file]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("document");
      const docBlock = blocks[0] as ClaudeDocumentBlock;
      expect(docBlock.source.type).toBe("base64");
      expect(docBlock.source.media_type).toBe("application/pdf");
    });

    it("creates text block for text files with file markers", () => {
      const file = createMockDownloadedFile({
        name: "code.ts",
        mimetype: "text/plain",
        data: Buffer.from("const x = 1;"),
      });

      const blocks = buildContentBlocks(undefined, [file]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      const textBlock = blocks[0] as ClaudeTextBlock;
      expect(textBlock.text).toContain("--- File: code.ts ---");
      expect(textBlock.text).toContain("const x = 1;");
      expect(textBlock.text).toContain("--- End of code.ts ---");
    });

    it("handles code files with octet-stream mimetype", () => {
      const file = createMockDownloadedFile({
        name: "app.tsx",
        mimetype: "application/octet-stream",
        data: Buffer.from("export default App;"),
      });

      const blocks = buildContentBlocks(undefined, [file]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      const textBlock = blocks[0] as ClaudeTextBlock;
      expect(textBlock.text).toContain("--- File: app.tsx ---");
    });

    it("combines text and files correctly", () => {
      const imageFile = createMockDownloadedFile({
        name: "photo.png",
        mimetype: "image/png",
        data: Buffer.from([0x89, 0x50]),
      });
      const textFile = createMockDownloadedFile({
        name: "readme.md",
        mimetype: "text/markdown",
        data: Buffer.from("# Title"),
      });

      const blocks = buildContentBlocks("Analyze these files", [imageFile, textFile]);

      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe("text");
      expect((blocks[0] as ClaudeTextBlock).text).toBe("Analyze these files");
      expect(blocks[1].type).toBe("image");
      expect(blocks[2].type).toBe("text");
    });

    it("adds fallback message when no content", () => {
      const blocks = buildContentBlocks(undefined, []);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect((blocks[0] as ClaudeTextBlock).text).toBe("Please analyze the attached file(s).");
    });

    it("adds fallback when only whitespace text", () => {
      const blocks = buildContentBlocks("   ", []);

      expect(blocks).toHaveLength(1);
      expect((blocks[0] as ClaudeTextBlock).text).toBe("Please analyze the attached file(s).");
    });

    it("skips unknown file types and logs warning", () => {
      const file = createMockDownloadedFile({
        name: "video.mp4",
        mimetype: "video/mp4",
        data: Buffer.from("video data"),
      });

      const blocks = buildContentBlocks("Check this", [file]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect((blocks[0] as ClaudeTextBlock).text).toBe("Check this");
      expect(mockLogWarn).toHaveBeenCalledWith(
        "Unknown file type, skipping",
        expect.objectContaining({ name: "video.mp4" })
      );
    });

    it("handles multiple images", () => {
      const files = [
        createMockDownloadedFile({ name: "a.png", mimetype: "image/png", data: Buffer.from("a") }),
        createMockDownloadedFile({ name: "b.jpg", mimetype: "image/jpeg", data: Buffer.from("b") }),
        createMockDownloadedFile({ name: "c.gif", mimetype: "image/gif", data: Buffer.from("c") }),
      ];

      const blocks = buildContentBlocks(undefined, files);

      expect(blocks).toHaveLength(3);
      expect(blocks.every(b => b.type === "image")).toBe(true);
    });

    it("logs block counts in debug mode", () => {
      const files = [
        createMockDownloadedFile({ name: "a.png", mimetype: "image/png", data: Buffer.from("a") }),
        createMockDownloadedFile({ name: "b.pdf", mimetype: "application/pdf", data: Buffer.from("b") }),
      ];

      buildContentBlocks("Hello", files);

      expect(mockLogDebug).toHaveBeenCalledWith(
        "Built content blocks",
        expect.objectContaining({
          textBlocks: 1,
          imageBlocks: 1,
          documentBlocks: 1,
        })
      );
    });
  });

  describe("buildStreamJsonMessage", () => {
    it("returns valid JSON string", () => {
      const result = buildStreamJsonMessage("Hello", []);

      expect(() => JSON.parse(result)).not.toThrow();
    });

    it("has correct structure", () => {
      const result = buildStreamJsonMessage("Test prompt", []);
      const parsed = JSON.parse(result);

      expect(parsed.type).toBe("user");
      expect(parsed.message.role).toBe("user");
      expect(Array.isArray(parsed.message.content)).toBe(true);
    });

    it("includes text content", () => {
      const result = buildStreamJsonMessage("Analyze this", []);
      const parsed = JSON.parse(result);

      expect(parsed.message.content).toHaveLength(1);
      expect(parsed.message.content[0].type).toBe("text");
      expect(parsed.message.content[0].text).toBe("Analyze this");
    });

    it("includes file content", () => {
      const file = createMockDownloadedFile({
        name: "image.png",
        mimetype: "image/png",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });

      const result = buildStreamJsonMessage("Check image", [file]);
      const parsed = JSON.parse(result);

      expect(parsed.message.content).toHaveLength(2);
      expect(parsed.message.content[0].type).toBe("text");
      expect(parsed.message.content[1].type).toBe("image");
      expect(parsed.message.content[1].source.type).toBe("base64");
    });

    it("handles empty input with fallback", () => {
      const result = buildStreamJsonMessage(undefined, []);
      const parsed = JSON.parse(result);

      expect(parsed.message.content[0].text).toBe("Please analyze the attached file(s).");
    });

    it("preserves base64 encoded data for images", () => {
      const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const file = createMockDownloadedFile({
        name: "test.png",
        mimetype: "image/png",
        data: imageData,
      });

      const result = buildStreamJsonMessage(undefined, [file]);
      const parsed = JSON.parse(result);

      expect(parsed.message.content[0].source.data).toBe(imageData.toString("base64"));
    });

    it("preserves base64 encoded data for PDFs", () => {
      const pdfData = Buffer.from("%PDF-1.4 test content");
      const file = createMockDownloadedFile({
        name: "doc.pdf",
        mimetype: "application/pdf",
        data: pdfData,
      });

      const result = buildStreamJsonMessage(undefined, [file]);
      const parsed = JSON.parse(result);

      expect(parsed.message.content[0].source.data).toBe(pdfData.toString("base64"));
    });
  });
});
