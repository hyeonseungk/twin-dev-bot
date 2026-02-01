import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../core/paths.js", () => ({
  CHANNELS_FILE: "/data/channels.json",
}));

import { setChannelDir, getChannelDir, removeChannelDir } from "../stores/channel-store.js";
import { writeFileSync, renameSync } from "fs";

describe("channel-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear in-memory state by removing and re-setting
    removeChannelDir("C123");
    removeChannelDir("C456");
  });

  it("sets and gets a channel directory", () => {
    setChannelDir("C123", { directory: "/projects/my-app", projectName: "my-app" });

    const result = getChannelDir("C123");
    expect(result).toEqual({
      directory: "/projects/my-app",
      projectName: "my-app",
    });
  });

  it("returns undefined for unknown channel", () => {
    expect(getChannelDir("C999")).toBeUndefined();
  });

  it("overwrites existing mapping", () => {
    setChannelDir("C123", { directory: "/projects/old", projectName: "old" });
    setChannelDir("C123", { directory: "/projects/new", projectName: "new" });

    const result = getChannelDir("C123");
    expect(result?.projectName).toBe("new");
  });

  it("removes a channel directory", () => {
    setChannelDir("C123", { directory: "/projects/my-app", projectName: "my-app" });
    removeChannelDir("C123");

    expect(getChannelDir("C123")).toBeUndefined();
  });

  it("saves to file on set", () => {
    setChannelDir("C123", { directory: "/projects/my-app", projectName: "my-app" });

    expect(writeFileSync).toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();
  });

  it("saves to file on remove", () => {
    setChannelDir("C123", { directory: "/projects/my-app", projectName: "my-app" });
    vi.clearAllMocks();

    removeChannelDir("C123");

    expect(writeFileSync).toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();
  });
});
