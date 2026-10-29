/**
 * Hermes has no `FinalizationRegistry`, and the session helpers (arrival's run lifecycle) construct one at load.
 * The registry only runs a cleanup after a collected target as a backstop, so a registry that never calls back is
 * correct: the explicit dispose path still runs.
 */
if (globalThis.FinalizationRegistry === undefined) {
  class SilentRegistry<T> {
    constructor(_cleanup: (held: T) => void) {}
    register(): void {}
    unregister(): boolean {
      return false;
    }
    readonly [Symbol.toStringTag] = "FinalizationRegistry";
  }
  Object.defineProperty(globalThis, "FinalizationRegistry", {
    value: SilentRegistry,
    configurable: true,
    writable: true,
  });
}
