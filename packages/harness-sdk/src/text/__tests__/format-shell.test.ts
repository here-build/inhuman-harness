import { expect, test } from "vitest";

import { formatShellCommand, formatShellCommandReady } from "../format-shell.js";

test("formatShellCommand reprints a compound command and leaves parse failures", async () => {
  const broken = "not a (( valid";
  expect({
    short: await formatShellCommandReady("git status --short"),
    iff: await formatShellCommandReady("if true;then echo x; echo y;fi"),
    compound: await formatShellCommandReady("ls && echo '=== server ==='; head -80 ./a.md 2>/dev/null"),
    brokenReady: await formatShellCommandReady(broken),
    brokenSync: formatShellCommand(broken),
  }).toEqual({
    short: "git status --short",
    iff: "if true; then\n  echo x\n  echo y\nfi",
    compound: "ls && echo '=== server ==='\nhead -80 ./a.md 2> /dev/null",
    brokenReady: broken,
    brokenSync: broken,
  });
});
