import { expect, it } from "vitest";

import { pickContinueSession } from "../continue-pick.js";

const sessions = {
  last: { lastMessageAt: 10 },
  older: { lastMessageAt: 5 },
  newest: { lastMessageAt: 20 },
};

async function pick(args: {
  key?: string | null;
  termContinue?: Record<string, string>;
  occupied?: string[];
  missing?: string[];
}) {
  const missing = new Set(args.missing);
  return pickContinueSession({
    key: args.key === undefined ? "k" : args.key,
    termContinue: args.termContinue ?? { k: "last" },
    sessions,
    occupied: new Set(args.occupied),
    sessionExists: async (id) => !missing.has(id),
  });
}

it("last orphaned wins; occupied last takes newest orphan; miss mints; workers excluded", async () => {
  expect({
    lastFree: await pick({}),
    lastBusy: await pick({ occupied: ["last"] }),
    lastGone: await pick({ missing: ["last"] }),
    lastBusyGoneOrphans: await pick({ occupied: ["last", "newest", "older"] }),
    noKey: await pick({ key: null }),
    lastBusyNewestGone: await pick({ occupied: ["last"], missing: ["newest"] }),
    workerExcluded: await pickContinueSession({
      key: "k",
      termContinue: { k: "last" },
      sessions: {
        last: { lastMessageAt: 10 },
        worker: { lastMessageAt: 99, recipeScope: "session" },
      },
      occupied: new Set(["last"]),
      sessionExists: async () => true,
    }),
  }).toEqual({
    lastFree: { sessionId: "last", staleKeyToClear: null },
    lastBusy: { sessionId: "newest", staleKeyToClear: null },
    lastGone: { sessionId: "newest", staleKeyToClear: "k" },
    lastBusyGoneOrphans: { sessionId: undefined, staleKeyToClear: null },
    noKey: { sessionId: undefined, staleKeyToClear: null },
    lastBusyNewestGone: { sessionId: "older", staleKeyToClear: null },
    workerExcluded: { sessionId: undefined, staleKeyToClear: null },
  });
});
