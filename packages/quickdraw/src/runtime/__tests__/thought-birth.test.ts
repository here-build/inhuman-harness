import { expect, test } from "vitest";

import { stepThoughtBirthFromSites } from "../thought_birth.js";

test("only the latest birth site crawls; earlier sites snap to T", () => {
  const frontiers = new Map();
  const t0 = 1_000;
  const older = { siteId: "think", T: 24 };
  const newest = { siteId: "speech", T: 8 };
  const both = stepThoughtBirthFromSites([older, newest], frontiers, t0);
  const later = stepThoughtBirthFromSites([older, newest], frontiers, t0 + 200);
  const onlyThink = stepThoughtBirthFromSites([older], frontiers, t0 + 400);
  expect({
    both: {
      think: both.get("think")?.W,
      speechBehind: (both.get("speech")?.W ?? 8) < 8,
    },
    later: {
      think: later.get("think")?.W,
      speechMoved: (later.get("speech")?.W ?? 0) > (both.get("speech")?.W ?? 0),
    },
    onlyThink: {
      W: onlyThink.get("think")?.W,
      speechGone: onlyThink.has("speech"),
    },
  }).toEqual({
    both: { think: 24, speechBehind: true },
    later: { think: 24, speechMoved: true },
    onlyThink: { W: 24, speechGone: false },
  });
});
