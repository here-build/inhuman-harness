/**
 * Tiny `fs.watch` wrapper for a fixed, small set of files and flat directories.
 *
 * Replaces chokidar here. chokidar 5 dropped its fsevents path, so on macOS it
 * emulates recursion in userspace and opens one fd per directory — a recursive
 * watch of this repo cost 19 897 fds and hit EMFILE. Every watch target in the
 * daemon is a named file or a shallow directory, so a flat watcher is all we
 * need, and it can never blow up like that.
 *
 * Not a general-purpose watcher: no globs, no recursion, no symlink chasing.
 */
import { lstatSync, watch, type FSWatcher } from "node:fs";

import { DisposableClass, disposableGuard } from "@inhuman.tools/harness-commons";

export interface WatchOptions {
  /** Ignore entry paths that change; the callback fires once per settled burst. */
  readonly debounceMs?: number;
  /** File-present gate: absent entries are polled until they appear. */
  readonly pollIntervalMs?: number;
  /** Best-effort: keep working (and retry) when a path cannot be watched yet. */
  readonly ignorePermissionErrors?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_POLL_MS = 80;

/**
 * Flat watcher over an explicit path list. Emits a single debounced `onChange`
 * for any change on any target; the set can be swapped at runtime via `set`.
 *
 * Non-existent paths are polled rather than watched — `config.json` may be
 * written after the kernel boots, and a missing strategy file appears later.
 */
export class FileSetWatcher extends DisposableClass {
  readonly #paths: string[] = [];
  readonly #onChange: () => void;
  readonly #debounceMs: number;
  readonly #pollIntervalMs: number;
  readonly #ignorePermissionErrors: boolean;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #pollers = new Map<string, ReturnType<typeof setInterval>>();
  /** kqueue reports atime bumps as `change`; a reader of the file would loop on itself. */
  readonly #stamps = new Map<string, string>();
  #debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(paths: readonly string[], onChange: () => void, options: WatchOptions = {}) {
    super();
    this.#onChange = onChange;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.#ignorePermissionErrors = options.ignorePermissionErrors ?? false;
    this.set(paths);
  }

  /** Swap the watched set. Unchanged paths keep their watchers. */
  @disposableGuard
  set(paths: readonly string[]): void {
    const next = new Set(paths);
    for (const path of this.#watchers.keys()) {
      if (!next.has(path)) this.#stop(path, this.#watchers);
    }
    for (const path of this.#pollers.keys()) {
      if (!next.has(path)) this.#stop(path, this.#pollers);
    }
    this.#paths.length = 0;
    this.#paths.push(...next);
    for (const path of next) this.#ensure(path);
  }

  #ensure(path: string): void {
    if (this.disposed) return;
    if (this.#watchers.has(path) || this.#pollers.has(path)) return;
    // Node's fs.watch throws ENOENT on a still-absent path; poll until it lands.
    if (!exists(path)) {
      this.#poll(path);
      return;
    }
    this.#stamps.set(path, stamp(path));
    let watcher: FSWatcher;
    try {
      watcher = watch(path, { persistent: false }, (event) => {
        if (this.disposed) return;
        // `rename` on a now-absent path means the entry left; fall back to polling.
        if (event === "rename" && !exists(path)) {
          this.#stop(path, this.#watchers);
          this.#poll(path);
          return;
        }
        const next = stamp(path);
        if (next !== "" && next === this.#stamps.get(path)) return;
        this.#stamps.set(path, next);
        this.#schedule();
      });
    } catch (error) {
      // EACCES/EMFILE: retry on the poll loop rather than failing the kernel.
      if (!this.#ignorePermissionErrors && !isTransient(error)) throw error;
      this.#poll(path);
      return;
    }
    watcher.on("error", () => {
      this.#stop(path, this.#watchers);
      if (!this.disposed) this.#poll(path);
    });
    this.#watchers.set(path, watcher);
  }

  /** Missing entries are re-checked until they exist, then watched. */
  #poll(path: string): void {
    if (this.disposed || this.#pollers.has(path)) return;
    const tick = (): void => {
      if (this.disposed) return;
      if (!exists(path)) return;
      this.#stop(path, this.#pollers);
      this.#ensure(path);
      // Appearing is itself the change the reflector needs to react to.
      this.#schedule();
    };
    const handle = setInterval(tick, this.#pollIntervalMs);
    handle.unref();
    this.#pollers.set(path, handle);
    tick();
  }

  #schedule(): void {
    if (this.disposed) return;
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined;
      if (!this.disposed) this.#onChange();
    }, this.#debounceMs);
    this.#debounce.unref();
  }

  #stop(path: string, table: Map<string, unknown>): void {
    const handle = table.get(path);
    table.delete(path);
    if (table === this.#watchers) this.#stamps.delete(path);
    if (handle === undefined) return;
    if (table === this.#watchers) (handle as FSWatcher).close();
    else clearInterval(handle as ReturnType<typeof setInterval>);
  }

  protected dispose(): void {
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    for (const path of this.#watchers.keys()) this.#stop(path, this.#watchers);
    for (const path of this.#pollers.keys()) this.#stop(path, this.#pollers);
    this.#paths.length = 0;
  }
}

function exists(path: string): boolean {
  try {
    // lstat so a dangling symlink still reads as absent.
    return lstatSync(path).size >= 0;
  } catch {
    return false;
  }
}

/** Content identity of a file; "" for directories, whose entry churn has no stamp. */
function stamp(path: string): string {
  try {
    const st = lstatSync(path);
    return st.isDirectory() ? "" : `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return "";
  }
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EMFILE" || code === "ENFILE";
}
