import { describe, expect, it } from "vitest";

import { evaluateCall, register, type CallJudge, type PermissionEvaluation, type PermissionHost } from "../index.js";

const flag = (match: object) => ({ match }) as never;
const allow: CallJudge = async () => "allow";

describe("opencode acknowledgement", () => {
  it("a flag turns a floor-approved call into the host's ask", async () => {
    const options = { env: {}, acknowledgeFlags: [flag({ command: ["git", "status"] })] };
    expect(await evaluateCall({ action: "bash", resources: ["git status"] }, options)).toBe("ask");
    expect(await evaluateCall({ action: "bash", resources: ["pwd"] }, options)).toBe("allow");
  });

  it("applies to a judge-allowed call", async () => {
    const options = { env: {}, judge: allow, acknowledgeFlags: [flag({ class: "package-install" })] };
    expect(await evaluateCall({ action: "bash", resources: ["npm install left-pad"] }, options)).toBe("ask");
  });

  it("deny and block are unaffected", async () => {
    const options = { env: {}, judge: async () => "deny" as const, acknowledgeFlags: [flag({ tool: "bash" })] };
    expect(await evaluateCall({ action: "bash", resources: ["rm file"] }, options)).toBe("deny");
    expect(await evaluateCall({ action: "bash", resources: ["rm .env"] }, options)).toBe("deny");
  });

  it("a tool flag reaches an action the gate otherwise skips; a read the floor approves", async () => {
    const options = { env: {}, cwd: "/w", acknowledgeFlags: [flag({ mcp: "gmail" })] };
    expect(await evaluateCall({ action: "mcp__gmail__send", resources: ["x"] }, options)).toBe("ask");
    const reads = { env: {}, cwd: "/w", acknowledgeFlags: [flag({ tool: "read" })] };
    expect(await evaluateCall({ action: "read", resources: ["a.ts"] }, reads)).toBe("ask");
  });

  async function hosted(
    opts: object,
    effect: PermissionEvaluation["effect"],
    action = "bash",
    resource = "git status",
  ) {
    let hook: ((event: PermissionEvaluation) => Promise<void>) | undefined;
    const host: PermissionHost = {
      options: opts,
      permission: {
        async hook(_name, callback) {
          hook = callback as never;
        },
      },
    };
    await register(host);
    const event: PermissionEvaluation = { action, resources: [resource], effect };
    await hook!(event);
    return event.effect;
  }

  it("register reads user and project flags from the plugin options", async () => {
    const user = { acknowledge: [{ match: { command: ["git"] } }] };
    expect(await hosted(user, "allow")).toBe("ask");
    expect(await hosted({ projectAcknowledge: [{ match: { command: ["git"] } }] }, "allow")).toBe("ask");
    expect(await hosted({ ...user, projectAcknowledge: [] }, "allow")).toBe("ask");
    expect(await hosted({}, "allow")).toBe("allow");
  });

  it("an earlier deny is never loosened to ask", async () => {
    expect(await hosted({ acknowledge: [{ match: { command: ["git"] } }] }, "deny")).toBe("deny");
  });

  it("an invalid block fails at load", async () => {
    await expect(hosted({ acknowledge: [{ match: { class: "nope" } }] }, "allow")).rejects.toThrow(
      /invalid acknowledge/,
    );
  });
});
