import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateCall } from "@inhuman.tools/policy-crush";
import { afterEach, describe, expect, it } from "vitest";

import { sageJudge } from "../index.js";

describe("sageJudge", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function allowFile(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-crush-sage-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    await writeFile(file, '"allow"\n');
    return file;
  }

  it("a missing key denies an ask", async () => {
    expect(await evaluateCall({ kind: "bash", command: "git pull" }, sageJudge({}))).toBe("deny");
  });

  it("a floor block denies without the model", async () => {
    expect(await evaluateCall({ kind: "write", path: ".env" }, sageJudge({ SAGE_API_KEY: "test-key" }))).toBe("deny");
  });

  it("only SAGE_API_KEY unlocks a user program", async () => {
    const file = await allowFile();
    const call = { kind: "bash" as const, command: "git pull" };
    const missing = await evaluateCall(call, sageJudge({ POLICY_AUTHORIZE: file }));
    const sage = await evaluateCall(call, sageJudge({ SAGE_API_KEY: "test-key", POLICY_AUTHORIZE: file }));
    const other = await evaluateCall(
      call,
      sageJudge({ JEV_API_KEY: "jev", TYPESAFE_API_KEY: "typesafe", POLICY_AUTHORIZE: file }),
    );
    const approved = await evaluateCall({ kind: "bash", command: "ls" }, sageJudge({ SAGE_API_KEY: "test-key" }));
    expect({ missing, sage, other, approved }).toEqual({
      missing: "deny",
      sage: "allow",
      other: "deny",
      approved: "allow",
    });
  });
});
