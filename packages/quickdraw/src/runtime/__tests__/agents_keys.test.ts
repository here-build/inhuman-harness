import { expect, test } from "vitest";

import { agentsRowKeyFromHit, sessionIdFromAgentsKey } from "../agents_keys.js";

test("session hit keys strip paint suffixes and reject gaps", () => {
  expect({
    row: [
      agentsRowKeyFromHit("session:s-auth"),
      agentsRowKeyFromHit("session:s-auth:name"),
      agentsRowKeyFromHit("session:s-auth:id-line"),
      agentsRowKeyFromHit("session:foo:bar:name"),
      agentsRowKeyFromHit("agents:sessions:gap:session:s-auth"),
      agentsRowKeyFromHit("call:call-explore"),
      agentsRowKeyFromHit("call:call-explore:name"),
      agentsRowKeyFromHit("call:call-explore:indent"),
      agentsRowKeyFromHit("bot:reviewer:recap"),
    ],
    id: [
      sessionIdFromAgentsKey("session:s-auth:name"),
      sessionIdFromAgentsKey("session:foo:bar:status"),
      sessionIdFromAgentsKey("session:"),
      sessionIdFromAgentsKey("call:x"),
    ],
  }).toEqual({
    row: [
      "session:s-auth",
      "session:s-auth",
      "session:s-auth",
      "session:foo:bar",
      null,
      "call:call-explore",
      "call:call-explore",
      "call:call-explore",
      "bot:reviewer",
    ],
    id: ["s-auth", "foo:bar", null, null],
  });
});
