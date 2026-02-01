import { vi, describe, it, expect } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../core/paths.js", () => ({
  DATA_DIR: "/mock/data",
  WORKSPACES_FILE: "/mock/data/workspaces.json",
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

async function importFresh() {
  vi.resetModules();
  const fs = await import("fs");
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);

  mockExistsSync.mockReturnValue(false);

  const mod = await import("../stores/workspace-store.js");
  return {
    addWorkspace: mod.addWorkspace,
    getWorkspace: mod.getWorkspace,
    removeWorkspace: mod.removeWorkspace,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  };
}

async function importWithFile(content: string) {
  vi.resetModules();
  const fs = await import("fs");
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);

  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(content);

  const mod = await import("../stores/workspace-store.js");
  return {
    addWorkspace: mod.addWorkspace,
    getWorkspace: mod.getWorkspace,
    removeWorkspace: mod.removeWorkspace,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  };
}

const THREAD_TS = "1706000000.000000";

const mockWorkspaceData = {
  directory: "/home/user/my-project",
  projectName: "my-project",
  channelId: "C123456",
};

describe("workspace-store", () => {
  describe("loadFromFile", () => {
    it("starts fresh when file doesn't exist", async () => {
      const { getWorkspace } = await importFresh();
      expect(getWorkspace(THREAD_TS)).toBeUndefined();
    });

    it("loads workspaces from valid JSON", async () => {
      const validData = JSON.stringify({
        version: 1,
        workspaces: [
          {
            threadTs: THREAD_TS,
            directory: "/home/user/my-project",
            projectName: "my-project",
            channelId: "C123456",
            autopilot: true,
          },
        ],
      });

      const { getWorkspace } = await importWithFile(validData);
      const ws = getWorkspace(THREAD_TS);
      expect(ws).toBeDefined();
      expect(ws!.projectName).toBe("my-project");
      expect(ws!.directory).toBe("/home/user/my-project");
      expect(ws!.channelId).toBe("C123456");
      expect(ws!.autopilot).toBe(true);
    });

    it("handles corrupted JSON", async () => {
      const { getWorkspace } = await importWithFile("not valid json {{{");
      expect(getWorkspace(THREAD_TS)).toBeUndefined();
    });

    it("handles invalid structure (no workspaces array)", async () => {
      const { getWorkspace } = await importWithFile(
        JSON.stringify({ version: 1, data: "wrong" })
      );
      expect(getWorkspace(THREAD_TS)).toBeUndefined();
    });

    it("skips bad entries", async () => {
      const data = JSON.stringify({
        version: 1,
        workspaces: [
          {
            threadTs: THREAD_TS,
            directory: "/home/user/proj",
            projectName: "proj",
            channelId: "C1",
          },
          null as unknown,
        ],
      });

      const { getWorkspace } = await importWithFile(data);
      expect(getWorkspace(THREAD_TS)).toBeDefined();
    });
  });

  describe("addWorkspace", () => {
    it("stores a workspace", async () => {
      const { addWorkspace, getWorkspace } = await importFresh();
      addWorkspace(THREAD_TS, mockWorkspaceData);
      expect(getWorkspace(THREAD_TS)).toEqual(mockWorkspaceData);
    });

    it("overwrites existing workspace for same threadTs", async () => {
      const { addWorkspace, getWorkspace } = await importFresh();
      addWorkspace(THREAD_TS, mockWorkspaceData);

      const updated = {
        directory: "/home/user/other-project",
        projectName: "other-project",
        channelId: "C999999",
        autopilot: true,
      };
      addWorkspace(THREAD_TS, updated);

      expect(getWorkspace(THREAD_TS)).toEqual(updated);
    });

    it("saves to file", async () => {
      const { addWorkspace, writeFileSync: mockWrite } = await importFresh();
      addWorkspace(THREAD_TS, mockWorkspaceData);
      expect(mockWrite).toHaveBeenCalled();
    });
  });

  describe("getWorkspace", () => {
    it("returns workspace for known threadTs", async () => {
      const { addWorkspace, getWorkspace } = await importFresh();
      addWorkspace(THREAD_TS, mockWorkspaceData);
      expect(getWorkspace(THREAD_TS)).toEqual(mockWorkspaceData);
    });

    it("returns undefined for unknown threadTs", async () => {
      const { getWorkspace } = await importFresh();
      expect(getWorkspace("9999999.000000")).toBeUndefined();
    });
  });

  describe("removeWorkspace", () => {
    it("removes a stored workspace and saves to file", async () => {
      const { addWorkspace, getWorkspace, removeWorkspace, writeFileSync: mockWrite } =
        await importFresh();
      addWorkspace(THREAD_TS, mockWorkspaceData);
      mockWrite.mockClear();

      removeWorkspace(THREAD_TS);

      expect(getWorkspace(THREAD_TS)).toBeUndefined();
      expect(mockWrite).toHaveBeenCalled();
    });

    it("is no-op for unknown threadTs", async () => {
      const { removeWorkspace } = await importFresh();
      expect(() => removeWorkspace("9999999.000000")).not.toThrow();
    });
  });
});
