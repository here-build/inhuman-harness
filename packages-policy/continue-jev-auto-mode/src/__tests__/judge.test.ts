import { describe, expect, it } from "vitest";

import { evaluateCall, jevJudge } from "../index.js";

describe("jevJudge", () => {
  it("a user program allows without calling the model", async () => {
    const judge = jevJudge("test-key", { program: '"allow"' });
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, judge)).toBe("allow");
  });

  it("a floor block denies without the model", async () => {
    const judge = jevJudge("test-key");
    expect(await evaluateCall({ kind: "write", path: ".env" }, judge)).toBe("deny");
  });

  it("a deny program and an empty key do not call the model", async () => {
    const denied = await evaluateCall(
      { kind: "bash", command: "git pull" },
      jevJudge("test-key", { program: '"deny"' }),
    );
    const missing = await evaluateCall({ kind: "bash", command: "git pull" }, jevJudge(""));
    const approved = await evaluateCall({ kind: "bash", command: "ls" }, jevJudge("test-key"));
    expect({ denied, missing, approved }).toEqual({ denied: "deny", missing: "deny", approved: "allow" });
  });
});
