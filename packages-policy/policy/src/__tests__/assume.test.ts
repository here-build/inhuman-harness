import { describe, expect, it } from "vitest";

import { PolicyAssumeError } from "../compile.js";
import { compile } from "./_helpers/compile.js";

const GIT = {
  bash: {
    policy: "ask",
    subcommands: {
      git: {
        policy: "ask",
        subcommands: {
          status: "approve",
          push: {
            policy: "ask",
            matcher: [{ flags: { "--force": { alias: ["-f"] } }, policy: "deny" }],
          },
        },
      },
    },
  },
} as const;

describe("assume", () => {
  it("authoring workflow", async () => {
    const wrong = await compile(
      JSON.stringify({
        ...GIT,
        assume: [{ command: "git push --force", expect: "approve" }],
      }),
    ).catch((error: unknown) => error);
    const missing = await compile(JSON.stringify({ assume: [{ command: "git push", expect: "deny" }] })).catch(
      (error: unknown) => error,
    );
    await compile(JSON.stringify({ ...GIT, assume: [{ command: "git status", expect: "approve" }] }));
    const later = await compile(
      JSON.stringify({
        bash: { policy: "ask", subcommands: { git: "deny" } },
        assume: [{ command: "git status", expect: "approve" }],
      }),
    ).catch((error: unknown) => error);

    function fields(error: unknown) {
      if (!(error instanceof PolicyAssumeError)) throw new Error("expected PolicyAssumeError");
      return {
        name: error.name,
        message: error.message,
        expected: error.expected,
        actual: error.actual,
        command: error.command,
      };
    }

    expect({ wrong: fields(wrong), missing: fields(missing), later: fields(later) }).toEqual({
      wrong: {
        name: "PolicyAssumeError",
        message: "assume: expected policyApprove, got deny: git push --force",
        expected: "policyApprove",
        actual: "deny",
        command: "git push --force",
      },
      missing: {
        name: "PolicyAssumeError",
        message: "assume: expected deny, got ask: git push",
        expected: "deny",
        actual: "ask",
        command: "git push",
      },
      later: {
        name: "PolicyAssumeError",
        message: "assume: expected policyApprove, got deny: git status",
        expected: "policyApprove",
        actual: "deny",
        command: "git status",
      },
    });
  });
});
