import type { PermissionEvaluation, PermissionHost } from "@inhuman.tools/policy-opencode";
import { describe, expect, it } from "vitest";

import { evaluateCall, register } from "../index.js";

describe("evaluateCall", () => {
  it("a missing key denies an ask", async () => {
    expect(await evaluateCall({ action: "shell", resources: ["git pull"] }, { env: {} })).toBe("deny");
  });

  it("a user program allows without the model", async () => {
    expect(await evaluateCall({ action: "shell", resources: ["rm -rf /tmp/x"] }, { env: {}, program: '"allow"' })).toBe(
      "allow",
    );
  });

  it("does not read SAGE_API_KEY", async () => {
    expect(await evaluateCall({ action: "shell", resources: ["git pull"] }, { env: { SAGE_API_KEY: "sage" } })).toBe(
      "deny",
    );
  });

  it("an empty jevApiKey is missing and does not read SAGE_API_KEY", async () => {
    expect(
      await evaluateCall(
        { action: "shell", resources: ["git pull"] },
        { env: { SAGE_API_KEY: "sage" }, jevApiKey: "" },
      ),
    ).toBe("deny");
  });

  it("JEV_API_KEY with a literal program allows without the model", async () => {
    expect(
      await evaluateCall(
        { action: "edit", resources: ["src/a.ts"] },
        { env: { JEV_API_KEY: "test-key" }, program: '"allow"' },
      ),
    ).toBe("allow");
  });
});

describe("register", () => {
  it("reads the program from plugin options", async () => {
    const event: PermissionEvaluation = { action: "shell", resources: ["rm -rf /tmp/x"], effect: "ask" };
    const ctx: PermissionHost = {
      options: { program: '"allow"', jevApiKey: "test-key" },
      permission: {
        hook: async (_name, callback) => {
          await callback(event);
        },
      },
    };
    await register(ctx);
    expect(event.effect).toBe("allow");
  });

  it("a missing program file denies and does not run the dist script", async () => {
    const event: PermissionEvaluation = { action: "shell", resources: ["git pull"], effect: "ask" };
    const ctx: PermissionHost = {
      options: { programPath: "/no/such/policy-authorize.scm", jevApiKey: "test-key" },
      permission: {
        hook: async (_name, callback) => {
          await callback(event);
        },
      },
    };
    await register(ctx);
    expect(event.effect).toBe("deny");
  });
});
