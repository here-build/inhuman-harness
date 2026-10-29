import { describe, expect, it, vi } from "vitest";

import { evaluateCall, evaluateCallWithReason } from "../index.js";

const flag = (match: object) => ({ match }) as never;
const bash = (command: string) => ({ kind: "bash" as const, command });
const allow = () => "allow" as const;

describe("acknowledgement", () => {
  const flags = [flag({ command: ["git", "status"] })];

  it("a flag forces an ack on a floor-approved call; accepted runs, refused is denied with a reason", async () => {
    const yes = vi.fn(async () => true);
    expect(await evaluateCall(bash("git status"), null, { acknowledgeFlags: flags, acknowledge: yes })).toBe("allow");
    expect(yes).toHaveBeenCalledOnce();
    expect(
      await evaluateCallWithReason(bash("git status"), null, {
        acknowledgeFlags: flags,
        acknowledge: async () => false,
      }),
    ).toEqual({ verdict: "deny", reason: "acknowledgement declined: command git status" });
  });

  it("no prompt path is a degraded denial with the exact reason", async () => {
    expect(await evaluateCallWithReason(bash("git status"), null, { acknowledgeFlags: flags })).toEqual({
      verdict: "deny",
      reason: "needs acknowledgement: command git status",
    });
  });

  it("applies to a judge-allowed call; unflagged calls do not prompt", async () => {
    const yes = vi.fn(async () => true);
    const options = { acknowledgeFlags: [flag({ class: "package-install" })], acknowledge: yes };
    expect(await evaluateCall(bash("npm install left-pad"), allow, options)).toBe("allow");
    expect(await evaluateCall(bash("rm file"), allow, options)).toBe("allow");
    expect(yes).toHaveBeenCalledOnce();
  });

  it("block and denial are unaffected and never prompt", async () => {
    const yes = vi.fn(async () => true);
    const options = { acknowledgeFlags: [flag({ tool: "bash" })], acknowledge: yes };
    expect(await evaluateCallWithReason(bash("rm .env"), allow, options)).toEqual({ verdict: "deny" });
    expect(await evaluateCallWithReason(bash("rm file"), () => "deny", options)).toEqual({ verdict: "deny" });
    expect(yes).not.toHaveBeenCalled();
  });

  it("a number is still the deadline", async () => {
    expect(await evaluateCall(bash("git status"), null, 10)).toBe("allow");
  });
});
