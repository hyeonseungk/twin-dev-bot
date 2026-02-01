import { describe, it, expect, vi, beforeEach } from "vitest";

describe("paths", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("ENV_FILE points to cwd/.env", async () => {
    const { ENV_FILE } = await import("../core/paths.js");
    expect(ENV_FILE).toBe(`${process.cwd()}/.env`);
  });

  it("DATA_DIR points to cwd/data", async () => {
    const { DATA_DIR } = await import("../core/paths.js");
    expect(DATA_DIR).toBe(`${process.cwd()}/data`);
  });

  it("SESSIONS_FILE is DATA_DIR/sessions.json", async () => {
    const { SESSIONS_FILE, DATA_DIR } = await import("../core/paths.js");
    expect(SESSIONS_FILE).toBe(`${DATA_DIR}/sessions.json`);
  });

  it("LOG_OUT is LOG_DIR/twindevbot.out.log", async () => {
    const { LOG_OUT, LOG_DIR } = await import("../core/paths.js");
    expect(LOG_OUT).toBe(`${LOG_DIR}/twindevbot.out.log`);
  });

  it("LOG_ERR is LOG_DIR/twindevbot.err.log", async () => {
    const { LOG_ERR, LOG_DIR } = await import("../core/paths.js");
    expect(LOG_ERR).toBe(`${LOG_DIR}/twindevbot.err.log`);
  });
});
