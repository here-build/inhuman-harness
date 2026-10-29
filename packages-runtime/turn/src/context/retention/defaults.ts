/**
 * Dist defaults for `contextRetention` (design §4.3). A turn minted before
 * retention existed resolves to {@link LEGACY_CONTEXT_RETENTION}: everything
 * lives until compaction, except what the owner fixed regardless of config —
 * pictures live only through their own turn, a system note only for its round.
 */
import type { ContextRetention } from "./schema.js";

export const DEFAULT_CONTEXT_RETENTION: ContextRetention = {
  version: 1,
  defaults: { minChars: 800 },
  step: { turnBoundary: true, everyRounds: 4, minFreedTokens: 8000, whenCacheCold: true, atCompaction: true },
  kinds: {
    "image.user": { keep: ["turn", { newest: 4 }], leave: "stub", minChars: 0 },
    "image.tool": { keep: ["turn", { newest: 2 }], leave: "stub", minChars: 0 },
    "tool.read": { keep: ["turn", { rounds: 10 }], leave: "stub" },
    "tool.search": { keep: { rounds: 2 }, leave: "stub" },
    "tool.shell": { keep: { rounds: 3 }, leave: "summary" },
    "tool.web.search": { keep: { rounds: 2 }, leave: "stub" },
    "tool.web.fetch": { keep: "turn", leave: "stub" },
    "tool.mcp": { keep: "turn", leave: "stub" },
    "tool.program": { keep: "turn", leave: { head: 400 } },
    "tool.agent": { keep: "compaction" },
    "tool.comm": { keep: "round", leave: "stub", minChars: 200 },
    "tool.write": { keep: "compaction" },
    "tool.other": { keep: "compaction" },
    "tool.args.write": { keep: "turn", leave: "stub", minChars: 2000 },
    thinking: { keep: "turn", leave: "none", minChars: 0 },
    steer: { keep: "compaction" },
    "approval-note": { keep: "compaction" },
    notification: { keep: "turn", leave: "summary" },
    "system-note": { keep: "round", leave: "none", minChars: 0 },
    error: { keep: "turn", leave: "summary", minChars: 0 },
  },
  tools: {},
  dialects: { anthropic: { keep: "forever" } },
};

const LEGACY_KINDS: ContextRetention["kinds"] = Object.fromEntries(
  Object.keys(DEFAULT_CONTEXT_RETENTION.kinds).map((kind) => [kind, { keep: "compaction", leave: "stub", minChars: 0 }]),
);

export const LEGACY_CONTEXT_RETENTION: ContextRetention = {
  version: 1,
  defaults: { minChars: 0 },
  step: { turnBoundary: true, everyRounds: null, minFreedTokens: 0, whenCacheCold: false, atCompaction: true },
  kinds: {
    ...LEGACY_KINDS,
    "image.user": { keep: ["turn", { newest: 4 }], leave: "stub", minChars: 0 },
    "image.tool": { keep: ["turn", { newest: 2 }], leave: "stub", minChars: 0 },
    "system-note": { keep: "round", leave: "none", minChars: 0 },
  },
  tools: {},
  dialects: {},
};
