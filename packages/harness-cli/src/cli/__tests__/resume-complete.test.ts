import { expect, it } from "vitest";

import { formatResumeCompletion, listResumeCompletions } from "../resume-complete.js";

const sessions = {
  live: { title: "auth refactor", lastMessageAt: 30 },
  old: { title: "docs", lastMessageAt: 5 },
  fresh: { title: "fix login", lastMessageAt: 20 },
  blank: { title: "", lastMessageAt: 10 },
};

it("lists resume rows, omits workers, filters, and formats", () => {
  const listed = listResumeCompletions({
    sessions,
    occupied: new Set(["live"]),
  });
  const omitted = listResumeCompletions({
    sessions: {
      ...sessions,
      worker: { title: "reviewer", lastMessageAt: 40, recipeScope: "session" },
      ask: { title: "check the diff", lastMessageAt: 50, oneShot: true },
    },
    occupied: new Set(),
  });
  expect({
    listed: listed.map((row) => `${row.id}:${row.occupied ? "used" : "orphaned"}`),
    formatUsed: formatResumeCompletion(listed[0]!),
    formatBlank: formatResumeCompletion(listed[2]!),
    omitted: omitted.map((row) => row.id),
    filterId: listResumeCompletions({ sessions, occupied: new Set(), prefix: "LIVE" }).map((row) => row.id),
    filterTitle: listResumeCompletions({ sessions, occupied: new Set(), prefix: "login" }).map((row) => row.id),
    sanitized: formatResumeCompletion({
      id: "s1",
      title: "a:b\tc",
      lastMessageAt: 1,
      occupied: false,
    }),
  }).toEqual({
    listed: ["live:used", "fresh:orphaned", "blank:orphaned", "old:orphaned"],
    formatUsed: "live\tauth refactor · used",
    formatBlank: "blank\tblank · orphaned",
    omitted: ["live", "fresh", "blank", "old"],
    filterId: ["live"],
    filterTitle: ["fresh"],
    sanitized: "s1\ta b c · orphaned",
  });
});
