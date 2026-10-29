import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateCall } from "@inhuman.tools/policy-crush";
import { afterEach, describe, expect, it } from "vitest";

import { jevJudge } from "../index.js";

describe("jevJudge", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function allowFile(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-crush-jev-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    await writeFile(file, '"allow"\n');
    return file;
  }

  it("a missing key denies an ask even when a user program would allow it", async () => {
    const file = await allowFile();
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, jevJudge({ POLICY_AUTHORIZE: file }))).toBe(
      "deny",
    );
  });

  it("reads TYPESAFE_API_KEY, then JEV_API_KEY, and not SAGE_API_KEY", async () => {
    const file = await allowFile();
    const call = { kind: "bash" as const, command: "git pull" };
    const typesafe = await evaluateCall(call, jevJudge({ TYPESAFE_API_KEY: "test-key", POLICY_AUTHORIZE: file }));
    const jev = await evaluateCall(
      call,
      jevJudge({ TYPESAFE_API_KEY: "", JEV_API_KEY: "test-key", POLICY_AUTHORIZE: file }),
    );
    const sage = await evaluateCall(call, jevJudge({ SAGE_API_KEY: "sage", POLICY_AUTHORIZE: file }));
    const blocked = await evaluateCall({ kind: "write", path: ".env" }, jevJudge({ JEV_API_KEY: "test-key" }));
    expect({ typesafe, jev, sage, blocked }).toEqual({
      typesafe: "allow",
      jev: "allow",
      sage: "deny",
      blocked: "deny",
    });
  });
});
