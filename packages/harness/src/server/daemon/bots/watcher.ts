import { mkdirSync } from "node:fs";

import { FileSetWatcher } from "../fs/watchFiles.js";

export class BotsWatcher implements Disposable {
  readonly ready: Promise<void>;
  readonly #watcher: FileSetWatcher;
  #closed = false;

  constructor(
    readonly dir: string,
    onChange: () => void,
  ) {
    mkdirSync(dir, { recursive: true });
    this.#watcher = new FileSetWatcher([dir], onChange, {
      debounceMs: 120,
      // `~/.inhuman/bots` may be unreadable in some test sandboxes.
      ignorePermissionErrors: true,
    });
    this.ready = Promise.resolve();
  }

  [Symbol.dispose](): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#watcher[Symbol.dispose]();
  }
}
