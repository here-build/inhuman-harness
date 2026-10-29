import { runStatusline, statusNote, watchGit } from "@inhuman.tools/statusline";
import { DEFAULT_STATUSLINE } from "@inhuman.tools/statusline/constants";

export interface RefresherOptions {
  /** Project directory the git view is computed for. */
  readonly dir: string;
  /** Receives the clause after every run, "" when quiet or failed. Called only on change. */
  readonly onChange: (clause: string) => void;
  /** Quiet period before a file event triggers a run. */
  readonly debounceMs?: number;
  /** Test seam: replaces the real statusline run. */
  readonly run?: (dir: string, signal: AbortSignal) => Promise<string>;
}

export interface Refresher {
  /** Request a run. Coalesced: never two at once, one rerun if requested mid-flight. */
  readonly refresh: () => Promise<void>;
  readonly current: () => string;
  readonly stop: () => void;
}

async function defaultRun(dir: string, signal: AbortSignal): Promise<string> {
  return statusNote(await runStatusline(DEFAULT_STATUSLINE, dir, signal));
}

export function createRefresher(options: RefresherOptions): Refresher {
  const { dir, onChange, debounceMs = 120, run = defaultRun } = options;
  const abort = new AbortController();
  let clause = "";
  let running = undefined as Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const once = async () => {
    let next = "";
    try {
      next = await run(dir, abort.signal);
    } catch {
      next = "";
    }
    if (stopped || next === clause) return;
    clause = next;
    onChange(clause);
  };

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again && !stopped);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  const stopWatch = watchGit(dir, () => void refresh(), debounceMs);

  return {
    refresh,
    current: () => clause,
    stop: () => {
      stopped = true;
      abort.abort();
      stopWatch();
    },
  };
}
