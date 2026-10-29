import { expect, it } from "vitest";

import { FileSetWatcher } from "../watchFiles.js";

it("set refuses a disposed watcher", () => {
  const watcher = new FileSetWatcher([], () => undefined);
  watcher[Symbol.dispose]();
  watcher[Symbol.dispose]();
  expect(watcher.disposed).toBe(true);
  expect(() => watcher.set(["/tmp/absent-after-dispose"])).toThrow("set: disposed");
});
