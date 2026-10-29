import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execState, toJS } from "@here.build/arrival";
import {
  structuredOutputDecideCapability,
  type DecideComplete,
  type DecideRequest,
} from "@inhuman.tools/env-capability-decision-structured";
import { afterEach, describe, expect, it } from "vitest";

import { authorizationProgram, authorizationSource, DecideError } from "../authorize.js";
import { authorize } from "../run-authorization.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sourceFailure(override: string | undefined, env: NodeJS.ProcessEnv): string {
  try {
    authorizationSource(override, env);
    return "";
  } catch (error) {
    return error instanceof DecideError ? error.message : String(error);
  }
}

describe("authorizationProgram", () => {
  it("asks the dist choice", async () => {
    let request: DecideRequest | undefined;
    const complete: DecideComplete = async (body) => {
      request = body;
      return { value: "deny" };
    };
    const state = await execState(authorizationProgram(), {
      capabilities: [structuredOutputDecideCapability],
      config: { document: "git status", complete },
    });
    const value = state.values.at(0);
    if (value === undefined) throw new Error("no result");
    expect({ verdict: toJS(value), request }).toEqual({
      verdict: "deny",
      request: {
        kind: "choose",
        instructions: "Is this call authorized?",
        document: "git status",
        options: [
          { option: "allow", description: "authorized" },
          { option: "deny", description: "not authorized" },
        ],
      },
    });
  });

  it("resolves the program text", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-authorize-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    const empty = path.join(dir, "empty.scm");
    await writeFile(file, '(decide/choose "mine")\n');
    await writeFile(empty, "  \n");
    expect({
      inline: authorizationSource('("allow")', { POLICY_AUTHORIZE: "ignored.scm" }),
      file: authorizationSource(undefined, { POLICY_AUTHORIZE: file }),
      missing: sourceFailure(undefined, { POLICY_AUTHORIZE: "/no/such/authorize.scm" }),
      empty: sourceFailure("  ", { POLICY_AUTHORIZE: empty }),
    }).toEqual({
      inline: '("allow")',
      file: '(decide/choose "mine")\n',
      missing: "authorization program not found: /no/such/authorize.scm",
      empty: "authorization program is empty",
    });
  });

  it("a literal allow does not call the model", async () => {
    expect(await authorize("git status", { program: '"allow"', capability: structuredOutputDecideCapability })).toBe(
      "allow",
    );
  });

  it("runs the capability it was given", async () => {
    let request: DecideRequest | undefined;
    const complete: DecideComplete = async (body) => {
      request = body;
      return { value: "deny" };
    };
    const verdict = await authorize("rm file", {
      capability: structuredOutputDecideCapability,
      config: { complete },
    });
    expect({ verdict, kind: request?.kind }).toEqual({ verdict: "deny", kind: "choose" });
  });

  it("a program that returns nothing is not an allow", async () => {
    expect(
      await authorize("git status", { program: ";; nothing\n", capability: structuredOutputDecideCapability }),
    ).toBeNull();
  });
});
