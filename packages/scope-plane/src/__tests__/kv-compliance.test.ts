import { describe, it } from "vitest";

import { MemoryKvStore } from "../kv-store.js";
import { runHarnessKvComplianceSuite } from "../testing.js";

runHarnessKvComplianceSuite("MemoryKvStore", { describe, it }, async () => {
  const store = new MemoryKvStore();
  return {
    store,
    cleanup: async () => {},
  };
});
