/**
 * Paint only to the process controlling TTY — never to a redirected stdout
 * that might be the vitest reporter's stream.
 */
import { execFileSync } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";

let fd: number | null = null;

function paintFd(): number {
  if (fd !== null) return fd;
  try {
    fd = openSync("/dev/tty", "w");
  } catch {
    // Fallback only when no controlling tty (should not happen in real terminal apps)
    fd = 1;
  }
  return fd;
}

export function paintWrite(bytes: string): void {
  writeSync(paintFd(), bytes);
}

/**
 * Cooked echo prints ESC as `^[` (ECHOCTL). Alt+Left (`CSI 1;3D`) then shows
 * up as the text `^[[1;3D` beside the painted grid.
 */
export function silenceTTYEcho(): () => void {
  let saved: string[] = [];
  try {
    saved = execFileSync("stty", ["-f", "/dev/tty", "-g"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    execFileSync("stty", ["-f", "/dev/tty", "-echo", "-echoctl"]);
  } catch {
    return () => {};
  }
  return () => {
    if (saved.length === 0) return;
    try {
      execFileSync("stty", ["-f", "/dev/tty", ...saved]);
    } catch {
      /* process is exiting */
    }
  };
}

export function paintClose(): void {
  if (fd !== null && fd !== 1) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  fd = null;
}
