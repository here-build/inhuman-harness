/**
 * Visual suite setup — mac loud-skip + terminal golden matcher.
 * Wire via vitest.terminals.config.ts setupFiles.
 */

import { beforeAll } from "vitest";

import { isDarwin } from "../mac.js";
import "./matchers.js";

beforeAll(() => {
  if (!isDarwin()) {
    console.warn("[terminal-e2e] non-darwin — visual suite should skip (mac-only by design)");
  }
});
