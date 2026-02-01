import type { DaemonManager } from "./types.js";

export type { DaemonManager } from "./types.js";

export async function createDaemonManager(): Promise<DaemonManager> {
  switch (process.platform) {
    case "darwin": {
      const { MacOSDaemonManager } = await import("./macos.js");
      return new MacOSDaemonManager();
    }
    case "win32": {
      const { WindowsDaemonManager } = await import("./windows.js");
      return new WindowsDaemonManager();
    }
    default:
      throw new Error(`Daemon management is not supported on ${process.platform}`);
  }
}
