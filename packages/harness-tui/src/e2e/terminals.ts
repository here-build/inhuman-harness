/**
 * Terminal app drivers — launch a command, focus, close.
 *
 * Launch uses `exec` so the shell is replaced by the scenario. When the
 * scenario exits, the session ends with "[Process completed]" and no
 * terminate-confirmation sheet.
 *
 * Terminal.app close is keyed by **tty** returned from `do script` (custom
 * title alone is unreliable after process completion).
 */

import { accessSync, chmodSync, constants, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import type { TerminalId } from "./terminals-types.js";

export type TerminalMeta = {
  id: TerminalId;
  /** Primary System Events process name (used for capture + focus). */
  processName: string;
  /**
   * Alternate process names for capture (macOS sometimes reports a different
   * casing or helper process). Tried in order after `processName`.
   */
  processNames?: readonly string[];
  label: string;
};

export type TerminalSession = {
  id: TerminalId;
  processName: string;
  /** Close only this session's window (best-effort). */
  [Symbol.asyncDispose](): Promise<void>;
};

export const TERMINALS: readonly TerminalMeta[] = [
  { id: "terminal-app", processName: "Terminal", label: "Terminal.app" },
  { id: "iterm", processName: "iTerm2", label: "iTerm2" },
  {
    id: "kitty",
    processName: "kitty",
    processNames: ["kitty", "Kitty"],
    label: "kitty",
  },
  {
    id: "wezterm",
    processName: "wezterm-gui",
    processNames: ["wezterm-gui", "WezTerm", "wezterm"],
    label: "WezTerm",
  },
  {
    id: "ghostty",
    processName: "Ghostty",
    processNames: ["Ghostty", "ghostty"],
    label: "Ghostty",
  },
] as const;

/** Process names to try when resolving a capturable window. */
export function captureProcessNames(meta: TerminalMeta): string[] {
  const names = [meta.processName, ...(meta.processNames ?? [])];
  return [...new Set(names)];
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execa("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Just enough of an execa child to reap it. */
type Spawned = { pid?: number | undefined };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reap a scenario we spawned, by pid — never by window.
 *
 * Detached launches lead their own process group, so the negative pid takes
 * the terminal and the shell it `exec`ed. A graceful `{type:"quit"}` normally
 * gets here first and finds nothing alive; this is the path for a scenario
 * that hung or never accepted the quit.
 *
 * Closing a *window* was the old approach and it leaked: `exec` means the
 * scenario is the window's process, so a successful quit already removed our
 * window, and the click landed on whatever the app had frontmost — someone
 * else's. Nothing was ever terminated, so the app lingered in the dock.
 */
async function reapSpawned(child: Spawned, graceMs = 1500): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  if (!alive(pid)) return;
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  signal("SIGKILL");
}

export async function isTerminalAvailable(id: TerminalId): Promise<boolean> {
  switch (id) {
    case "terminal-app":
      return exists("/System/Applications/Utilities/Terminal.app") || exists("/Applications/Utilities/Terminal.app");
    case "iterm":
      return exists("/Applications/iTerm.app");
    case "kitty":
      return !!(await which("kitty")) || exists("/Applications/kitty.app");
    case "wezterm":
      return !!(await which("wezterm")) || exists("/Applications/WezTerm.app");
    case "ghostty":
      return exists("/Applications/Ghostty.app") || !!(await which("ghostty"));
    default:
      return false;
  }
}

export async function listAvailableTerminals(): Promise<TerminalMeta[]> {
  const out: TerminalMeta[] = [];
  for (const t of TERMINALS) {
    if (await isTerminalAvailable(t.id)) out.push(t);
  }
  return out;
}

export type OpenTerminalOpts = {
  command: string;
  cwd?: string;
};

function execShellLine(cwd: string, cmd: string): string {
  // TERMINAL_E2E=1: fixture refuses to paint without this (blocks vitest TTY leaks).
  // exec: replace shell so "[Process completed]" has no leftover zsh.
  return `cd ${shQuote(cwd)} && export TERMINAL_E2E=1 && exec ${cmd}`;
}

/**
 * Open `command` in a new window. Returns a session whose `close()` targets
 * that window only (Terminal.app via tty).
 */
export async function openTerminal(id: TerminalId, opts: OpenTerminalOpts): Promise<TerminalSession> {
  const cwd = opts.cwd ?? process.cwd();
  const cmd = opts.command;
  const shell = execShellLine(cwd, cmd);
  const meta = metaFor(id);

  switch (id) {
    case "terminal-app": {
      // Launch via a temp .command file + `open -na Terminal` so the scenario
      // gets a brand-new process group / window, never the suite's TTY.
      // Then resolve tty via the newest tab titled terminal-e2e.
      const dir = mkdtempSync(join(tmpdir(), "terminal-e2e-"));
      const scriptPath = join(dir, "run.command");
      writeFileSync(
        scriptPath,
        `#!/bin/bash\n# terminal-e2e scenario launcher\nprintf '\\e]0;terminal-e2e\\a'\n${shell}\n`,
        "utf8",
      );
      chmodSync(scriptPath, 0o755);
      // -n: new instance/window behavior; -a Terminal opens .command in Terminal.app
      await execa("open", ["-a", "Terminal", scriptPath], {
        stdio: "ignore",
      });
      // Brief wait for window/tab to register
      await new Promise((resolve) => setTimeout(resolve, 400));
      const tty = await resolveTerminalAppTtyByTitle("terminal-e2e");
      return {
        id,
        processName: meta.processName,
        [Symbol.asyncDispose]: async () => {
          await closeTerminalAppByTty(tty);
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        },
      };
    }
    case "iterm": {
      // Keep the created window's id: it is the only handle that survives
      // across osascript invocations, and closing by anything else ("front
      // window") would target a window we do not own.
      const script = `
tell application "iTerm"
  activate
  set w to (create window with default profile command ${JSON.stringify(shell)})
  return id of w as text
end tell
`;
      const { stdout } = await execa("osascript", ["-e", script]);
      const windowId = stdout.trim();
      return {
        id,
        processName: meta.processName,
        [Symbol.asyncDispose]: () => closeItermByWindowId(windowId),
      };
    }
    case "kitty": {
      const kitty = (await which("kitty")) ?? "/Applications/kitty.app/Contents/MacOS/kitty";
      const child = execa(kitty, ["--title", "terminal-e2e", "sh", "-lc", shell], { detached: true, stdio: "ignore" });
      child.unref();
      return {
        id,
        processName: meta.processName,
        [Symbol.asyncDispose]: () => reapSpawned(child),
      };
    }
    case "wezterm": {
      const wez = (await which("wezterm")) ?? "wezterm";
      const child = execa(wez, ["start", "--cwd", cwd, "--", "sh", "-lc", `export TERMINAL_E2E=1 && exec ${cmd}`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return {
        id,
        processName: meta.processName,
        [Symbol.asyncDispose]: () => reapSpawned(child),
      };
    }
    case "ghostty": {
      const ghostty = (await which("ghostty")) ?? "/Applications/Ghostty.app/Contents/MacOS/ghostty";
      const child = execa(ghostty, ["-e", "sh", "-lc", shell], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return {
        id,
        processName: meta.processName,
        [Symbol.asyncDispose]: () => reapSpawned(child),
      };
    }
    default:
      throw new Error(`unknown terminal ${id as string}`);
  }
}

/** Find tty of a tab whose custom title or window name contains `title`. */
async function resolveTerminalAppTtyByTitle(title: string): Promise<string> {
  const script = `
tell application "Terminal"
  repeat with w in windows
    try
      repeat with t in tabs of w
        try
          -- The launcher sets the title with an OSC escape, which lands in
          -- "name", not "custom title" (only AppleScript sets the latter).
          if (name of t contains ${JSON.stringify(title)}) or (custom title of t is ${JSON.stringify(title)}) then
            return tty of t
          end if
        end try
      end repeat
    end try
  end repeat
  -- No fallback to the front window: an unmatched launch means we do not know
  -- which window is ours, and closing a guess is how the operator's own shell
  -- got killed. Leaking a window is recoverable; that was not.
  return ""
end tell
`;
  try {
    const { stdout } = await execa("osascript", ["-e", script]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Close Terminal.app window/tab that owns `tty` (e.g. /dev/ttys007).
 * Works after "[Process completed]" — title matching does not.
 */
async function closeTerminalAppByTty(tty: string): Promise<void> {
  if (!tty) {
    console.warn("[terminal-e2e] Terminal.app window not identified — leaving it open");
    return;
  }
  const script = `
tell application "Terminal"
  set closedAny to false
  repeat with w in windows
    try
      repeat with t in tabs of w
        try
          if tty of t is ${JSON.stringify(tty)} then
            -- close the whole window that holds this tab
            close w
            set closedAny to true
            exit repeat
          end if
        end try
      end repeat
    end try
    if closedAny then exit repeat
  end repeat
  -- If still around (some macOS builds match tty without leading /dev/)
  if not closedAny then
    set shortTty to ${JSON.stringify(tty.replace(/^\/dev\//, ""))}
    repeat with w in windows
      try
        repeat with t in tabs of w
          try
            set tt to tty of t as text
            if tt ends with shortTty or tt is ${JSON.stringify(tty)} then
              close w
              set closedAny to true
              exit repeat
            end if
          end try
        end repeat
      end try
      if closedAny then exit repeat
    end repeat
  end if
end tell
delay 0.15
-- Dismiss terminate sheet if a shell was still live
tell application "System Events"
  tell process "Terminal"
    repeat with w in (get every window)
      try
        if exists sheet 1 of w then
          try
            click button "Terminate" of sheet 1 of w
          on error
            try
              click button "Close" of sheet 1 of w
            end try
          end try
        end if
      end try
    end repeat
  end tell
end tell
`;
  try {
    await execa("osascript", ["-e", script]);
  } catch {
    /* ignore */
  }
}

/** Close the one iTerm2 window we created. Unknown id: leave it alone. */
async function closeItermByWindowId(windowId: string): Promise<void> {
  if (!windowId) {
    console.warn("[terminal-e2e] iTerm2 window id unknown — leaving it open");
    return;
  }
  const script = `
tell application "iTerm"
  try
    close (first window whose id is ${JSON.stringify(windowId)})
  end try
end tell
`;
  try {
    await execa("osascript", ["-e", script]);
  } catch {
    /* ignore */
  }
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", String.raw`'\''`)}'`;
}

export function metaFor(id: TerminalId): TerminalMeta {
  const m = TERMINALS.find((t) => t.id === id);
  if (!m) throw new Error(`unknown terminal ${id}`);
  return m;
}
