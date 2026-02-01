import { homedir } from "os";
import { join } from "path";

/**
 * Cross-platform home directory.
 * Replaces all instances of: process.env.HOME || "/root"
 */
export function getHomeDir(): string {
  return homedir();
}

/**
 * Cross-platform tilde expansion.
 * Replaces ~/ (or ~\) with the user's home directory.
 */
export function expandTilde(p: string): string {
  if (p === "~") return getHomeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(getHomeDir(), p.slice(2));
  }
  return p;
}

/**
 * Default base directory for projects.
 */
export function getDefaultBaseDir(): string {
  return join(getHomeDir(), "Desktop");
}

/**
 * Whether the current platform supports daemon management.
 */
export function isDaemonSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}
