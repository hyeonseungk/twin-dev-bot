import { describe, it, expect } from "vitest";
import { getHomeDir, expandTilde, getDefaultBaseDir, isDaemonSupported } from "../core/platform.js";
import { homedir } from "os";
import { join } from "path";

describe("getHomeDir()", () => {
  it("returns os.homedir()", () => {
    expect(getHomeDir()).toBe(homedir());
  });

  it("returns a non-empty string", () => {
    const result = getHomeDir();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("expandTilde()", () => {
  it("expands ~/ paths", () => {
    const result = expandTilde("~/Documents");
    expect(result).toBe(join(homedir(), "Documents"));
  });

  it("expands ~\\ paths (Windows-style)", () => {
    const result = expandTilde("~\\Documents");
    expect(result).toBe(join(homedir(), "Documents"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  it("expands bare tilde to home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
  });
});

describe("getDefaultBaseDir()", () => {
  it("returns homedir/Desktop", () => {
    expect(getDefaultBaseDir()).toBe(join(homedir(), "Desktop"));
  });
});

describe("isDaemonSupported()", () => {
  it("returns a boolean", () => {
    expect(typeof isDaemonSupported()).toBe("boolean");
  });

  it("returns true on current platform (macOS)", () => {
    // 이 테스트는 macOS에서 실행 시에만 의미가 있음
    if (process.platform === "darwin") {
      expect(isDaemonSupported()).toBe(true);
    }
  });
});
