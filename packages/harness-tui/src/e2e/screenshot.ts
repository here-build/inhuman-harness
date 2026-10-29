/**
 * Capture a rectangular region of the screen via macOS `screencapture -R`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

export type Rect = { x: number; y: number; width: number; height: number };

export async function captureRect(rect: Rect): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "terminal-e2e-"));
  const file = join(dir, "shot.png");
  try {
    // -x silent, -R x,y,w,h region, -o no shadow (ignored for -R)
    await execa("screencapture", [
      "-x",
      "-R",
      `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
      file,
    ]);
    return readFileSync(file);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * AppleScript: bounds of the front window of a process (global screen coords).
 * Returns {x,y,width,height} or null if missing.
 */
export async function frontWindowBounds(processName: string): Promise<Rect | null> {
  const script = `
tell application "System Events"
  if not (exists process ${JSON.stringify(processName)}) then return ""
  tell process ${JSON.stringify(processName)}
    if (count of windows) is 0 then return ""
    -- Prefer the frontmost window; fall back to window 1.
    set wref to missing value
    try
      set wref to first window whose value of attribute "AXMain" is true
    end try
    if wref is missing value then set wref to window 1
    set p to position of wref
    set s to size of wref
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell
`;
  try {
    const { stdout } = await execa("osascript", ["-e", script]);
    const t = stdout.trim();
    if (!t) return null;
    const [x, y, w, h] = t.split(",").map(Number);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
    return { x: x!, y: y!, width: w!, height: h! };
  } catch {
    return null;
  }
}

/** Best-effort: raise process so its window is queryable / capturable. */
async function activateProcess(processName: string): Promise<void> {
  const script = `
tell application "System Events"
  if exists process ${JSON.stringify(processName)} then
    set frontmost of process ${JSON.stringify(processName)} to true
  end if
end tell
`;
  try {
    await execa("osascript", ["-e", script]);
  } catch {
    /* ignore — capture may still work */
  }
}

export type CaptureFrontWindowOpts = {
  settleMs?: number;
  /**
   * Alternate System Events process names (kitty/Ghostty casing, WezTerm
   * gui vs app). Tried in order after the primary name.
   */
  processNames?: readonly string[];
  /** Retries after settle when bounds are null (cold window). Default 8. */
  retries?: number;
  /** Delay between retries (ms). Default 250. */
  retryDelayMs?: number;
};

/**
 * Capture the front window of a terminal process. Retries + alternate process
 * names — kitty/Ghostty sometimes register late or under a different name.
 */
export async function captureFrontWindow(
  processName: string,
  settleMsOrOpts: number | CaptureFrontWindowOpts = 400,
): Promise<Buffer> {
  const opts: CaptureFrontWindowOpts =
    typeof settleMsOrOpts === "number" ? { settleMs: settleMsOrOpts } : settleMsOrOpts;
  const settleMs = opts.settleMs ?? 400;
  const retries = opts.retries ?? 8;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  const names = [processName, ...(opts.processNames ?? []).filter((n) => n !== processName)];

  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

  let lastBounds: Rect | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const name of names) {
      if (attempt > 0 || names.length > 1) await activateProcess(name);
      const bounds = await frontWindowBounds(name);
      lastBounds = bounds;
      if (bounds && bounds.width >= 8 && bounds.height >= 8) {
        return captureRect(bounds);
      }
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `no capturable front window for process ${names.join("|")} ` +
      `(bounds=${JSON.stringify(lastBounds)}; tried ${retries + 1}×)`,
  );
}
