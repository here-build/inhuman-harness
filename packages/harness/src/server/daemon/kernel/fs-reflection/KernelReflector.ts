import type { KernelRoot } from "@inhuman.tools/harness-model";
import { reaction, type IReactionDisposer } from "mobx";

import { openDriverRegistry, type DriverRegistry } from "@/connections";

import { reflectKernel } from "./reflectKernel.js";
import { watchPaths } from "./WatchPaths.js";
import { PRODUCT_PROVIDERS } from "../../../composition.js";
import { FileSetWatcher } from "../../fs/watchFiles.js";

/**
 * Reflect kernel configuration files into the plexus root, and keep it in sync.
 *
 * The watched set is derived from configuration — `compact.scm` and friends are
 * not hardcoded; they are whatever `config.json` (or a default) points at. So
 * the paths are recomputed by a mobx reaction over the very state the reflector
 * writes: an operator edits `config.json`, the file watcher fires, the reflector
 * re-reads it, the reaction sees the new strategy paths, and the watcher set
 * follows. No `watcher.add()` on every event, no stale paths.
 */
export class KernelReflector implements Disposable {
  readonly ready: Promise<void>;
  readonly #watcher: FileSetWatcher;
  readonly #disposeReaction: IReactionDisposer;
  #closed = false;

  constructor(
    readonly path: string,
    readonly root: KernelRoot,
    readonly registry: DriverRegistry = openDriverRegistry(PRODUCT_PROVIDERS),
  ) {
    reflectKernel(path, root, registry);
    this.#watcher = new FileSetWatcher([], () => {
      if (this.#closed) return;
      reflectKernel(path, root, registry);
    });
    this.ready = Promise.resolve();
    this.#disposeReaction = reaction(
      () => watchPaths(path, root),
      (paths) => this.#watcher.set(paths),
      { fireImmediately: true },
    );
  }

  [Symbol.dispose](): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposeReaction();
    this.#watcher[Symbol.dispose]();
  }
}
