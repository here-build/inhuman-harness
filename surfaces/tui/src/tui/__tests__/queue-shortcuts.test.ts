import { describe, expect, it } from "vitest";

import { HOTKEY_EVENT } from "../ask-shortcuts.js";
import { busyDraftShortcuts } from "../queue-shortcuts.js";

describe("busy draft shortcuts", () => {
  it("queues, steers, and retries from draft × queued × retrying", () => {
    const rows = [
      { draft: "later", queued: 0 },
      { draft: "  ", queued: 2 },
      { draft: "", queued: 0 },
      { draft: "", queued: 0, retrying: true },
      { draft: "", queued: 2, retrying: true },
      { draft: "later", queued: 0, retrying: true },
    ] as const;
    expect(rows.map((row) => busyDraftShortcuts(row))).toEqual([
      [{ key: "Enter", action: "queue message", event: HOTKEY_EVENT.queueMessage }],
      [
        { key: "Enter", action: "steer first", event: HOTKEY_EVENT.steerFirst },
        { key: "Esc", action: "retract last queued" },
      ],
      undefined,
      [{ key: "Ctrl+Enter", action: "retry now", event: HOTKEY_EVENT.retry }],
      [
        { key: "Enter", action: "steer first", event: HOTKEY_EVENT.steerFirst },
        { key: "Ctrl+Enter", action: "retry now", event: HOTKEY_EVENT.retry },
        { key: "Esc", action: "retract last queued" },
      ],
      [{ key: "Enter", action: "queue message", event: HOTKEY_EVENT.queueMessage }],
    ]);
  });
});
