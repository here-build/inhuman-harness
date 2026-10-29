import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_STATUSLINE, runStatusline, statusNote, watchGit } from "@inhuman.tools/statusline";

/** The footer slot. pi sorts statuses by key. */
export const STATUS_KEY = "git";
export const SETTINGS_FILE = "statusline-pi.json";
const TIMEOUT_MS = 5000;
const DEBOUNCE_MS = 120;

/** The slice of pi's extension API this package uses (earendil-works/pi `core/extensions/types.ts`). */
export type PiCtx = {
  readonly cwd: string;
  readonly ui: { setStatus(key: string, text: string | undefined): void };
};

type Handler = (event: unknown, ctx: PiCtx) => void;

export type PiHost = {
  on(
    event: "session_start" | "session_shutdown" | "tool_execution_end" | "turn_end" | "agent_end",
    handler: Handler,
  ): unknown;
};

export type Options = {
  readonly agentDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly readFile?: (file: string) => string | undefined;
  readonly run?: (cwd: string, signal: AbortSignal) => Promise<string>;
  /** Test seam: starts watching `cwd`, returns a stop function. Default `watchGit`. */
  readonly watch?: (cwd: string, onChange: () => void, debounceMs: number) => () => void;
  readonly debounceMs?: number;
};

export function agentDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const trimmed = env.PI_CODING_AGENT_DIR?.trim();
  return trimmed === undefined || trimmed === "" ? path.join(home, ".pi", "agent") : trimmed;
}

export function readEnabled(text: string | undefined): boolean {
  if (text === undefined) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "enabled" in parsed) return parsed.enabled !== false;
  } catch {
    // An unreadable settings file counts as absent.
  }
  return true;
}

function readQuietly(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

async function defaultRun(cwd: string, signal: AbortSignal): Promise<string> {
  return runStatusline(DEFAULT_STATUSLINE, cwd, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]));
}

export function register(pi: PiHost, options: Options = {}): void {
  const agentDir = options.agentDir ?? agentDirectory(options.env ?? process.env, options.home ?? homedir());
  const read = options.readFile ?? readQuietly;
  const run = options.run ?? defaultRun;
  const watch = options.watch ?? watchGit;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  let ctx: PiCtx | undefined;
  let running = false;
  let dirty = false;
  let controller: AbortController | undefined;
  let stopWatch: (() => void) | undefined;

  const paint = (text: string | undefined): void => {
    try {
      ctx?.ui.setStatus(STATUS_KEY, text);
    } catch {
      // Never throw into pi.
    }
  };

  async function pass(): Promise<void> {
    const current = ctx;
    if (current === undefined) return;
    controller = new AbortController();
    try {
      const note = statusNote(await run(current.cwd, controller.signal));
      if (controller.signal.aborted) return;
      paint(note === "" ? undefined : note);
    } catch {
      if (!controller.signal.aborted) paint(undefined);
    }
  }

  function refresh(): void {
    if (ctx === undefined) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          dirty = false;
          await pass();
        } while (dirty && ctx !== undefined);
      } finally {
        running = false;
      }
    })();
  }

  function closeWatchers(): void {
    stopWatch?.();
    stopWatch = undefined;
  }

  function startWatching(cwd: string): void {
    closeWatchers();
    stopWatch = watch(cwd, refresh, debounceMs);
  }

  pi.on("session_start", (_event, next) => {
    closeWatchers();
    if (!readEnabled(read(path.join(agentDir, SETTINGS_FILE)))) {
      ctx = undefined;
      return;
    }
    ctx = next;
    startWatching(next.cwd);
    refresh();
  });
  for (const event of ["tool_execution_end", "turn_end", "agent_end"] as const) {
    pi.on(event, () => {
      refresh();
    });
  }
  pi.on("session_shutdown", () => {
    controller?.abort();
    closeWatchers();
    dirty = false;
    ctx = undefined;
  });
}

export default register;
