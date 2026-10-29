import { describe, expect, it } from "vitest";

import { evaluateCall, register, type CallJudge, type PermissionEvaluation, type PermissionHost } from "../index.js";

const closed = { env: {} };

describe("evaluateCall: action names, paths, deadline", () => {
  it("bash is gated like shell", async () => {
    expect(await evaluateCall({ action: "bash", resources: ["sudo ls"] }, closed)).toBe("deny");
  });

  it.each(["src/../.git/hooks/pre-commit", ".GIT/hooks/pre-commit"])("edit %s is a floor block", async (target) => {
    let calls = 0;
    const judge: CallJudge = async () => {
      calls += 1;
      return "allow";
    };
    expect(await evaluateCall({ action: "edit", resources: [target] }, { env: {}, judge })).toBe("deny");
    expect(calls).toBe(0);
  });

  it("read of a secret is denied; read of an in-tree file is left to the host", async () => {
    expect(await evaluateCall({ action: "read", resources: ["src/../.env"] }, closed)).toBe("deny");
    expect(await evaluateCall({ action: "read", resources: ["src/a.ts"] }, { ...closed, cwd: "/work/proj" })).toBe(
      "skip",
    );
  });

  it("a judge that never answers is denied at the deadline", async () => {
    const hung: CallJudge = () => new Promise(() => undefined);
    expect(
      await evaluateCall({ action: "bash", resources: ["rm -rf /tmp/x"] }, { env: {}, judge: hung, deadlineMs: 20 }),
    ).toBe("deny");
  });
});

describe("evaluateCall", () => {
  it("sudo ls denies without the judge", async () => {
    expect(await evaluateCall({ action: "shell", resources: ["sudo ls"] }, closed)).toBe("deny");
  });

  it("a judge throw denies", async () => {
    let seen = "";
    const judge: CallJudge = (document) => {
      seen = document;
      throw new Error("judge down");
    };
    expect(await evaluateCall({ action: "shell", resources: ["sudo ls"] }, { env: {}, judge })).toBe("deny");
    expect(seen).toBe("sudo ls");
  });

  it("a null judge vote denies", async () => {
    const decision = await evaluateCall(
      { action: "shell", resources: ["rm -rf /tmp/x"] },
      { env: {}, judge: async () => null },
    );
    expect(decision).toBe("deny");
  });

  it("an ask floor allows when the judge allows", async () => {
    let seen = "";
    const decision = await evaluateCall(
      { action: "shell", resources: ["rm -rf /tmp/x"] },
      {
        env: {},
        judge: async (document) => {
          seen = document;
          return "allow";
        },
      },
    );
    expect(seen).toBe("rm -rf /tmp/x");
    expect(decision).toBe("allow");
  });

  it("edit of .env is a floor block and does not call the judge", async () => {
    let calls = 0;
    const decision = await evaluateCall(
      { action: "edit", resources: [".env"] },
      {
        env: {},
        judge: async () => {
          calls += 1;
          return "allow";
        },
      },
    );
    expect(calls).toBe(0);
    expect(decision).toBe("deny");
  });

  it("git status is approved without the judge", async () => {
    let calls = 0;
    const decision = await evaluateCall(
      { action: "shell", resources: ["git status"] },
      {
        env: {},
        judge: async () => {
          calls += 1;
          return "deny";
        },
      },
    );
    expect(calls).toBe(0);
    expect(decision).toBe("allow");
  });

  it("a user program replaces the dist script", async () => {
    const decision = await evaluateCall(
      { action: "shell", resources: ["rm -rf /tmp/x"] },
      { env: {}, program: '"allow"' },
    );
    expect(decision).toBe("allow");
  });

  it("read goes through the read floor (a secret denies); other actions are not ours", async () => {
    expect(await evaluateCall({ action: "read", resources: [".env"] }, closed)).toBe("deny");
    expect(await evaluateCall({ action: "webfetch", resources: ["https://x"] }, closed)).toBe("skip");
  });

  it("one blocked resource denies the call, and only an ask is voted", async () => {
    const seen: string[] = [];
    const judge: CallJudge = async (document) => {
      seen.push(document);
      return document === "git pull" ? "allow" : "deny";
    };
    const blocked = await evaluateCall({ action: "edit", resources: ["src/a.ts", ".env"] }, { env: {}, judge });
    const voted = await evaluateCall({ action: "shell", resources: ["git status", "git pull"] }, { env: {}, judge });
    const stopped = await evaluateCall(
      { action: "shell", resources: ["git pull", "rm -rf /tmp/y"] },
      {
        env: {},
        judge: async (document) => {
          seen.push(document);
          return "deny";
        },
      },
    );
    const empty = await evaluateCall({ action: "shell", resources: [] }, closed);
    expect({ blocked, voted, stopped, empty, seen }).toEqual({
      blocked: "deny",
      voted: "allow",
      stopped: "deny",
      empty: "skip",
      seen: ["git pull", "git pull"],
    });
  });

  it("a missing program file denies and does not run the dist script", async () => {
    const decision = await evaluateCall(
      { action: "shell", resources: ["git pull"] },
      { env: {}, programPath: "/no/such/policy-authorize.scm" },
    );
    expect(decision).toBe("deny");
  });
});

describe("register", () => {
  async function run(event: PermissionEvaluation): Promise<PermissionEvaluation> {
    const ctx: PermissionHost = {
      permission: {
        hook: async (name, callback) => {
          expect(name).toBe("evaluate");
          await callback(event);
        },
      },
    };
    await register(ctx, closed);
    return event;
  }

  it("does not assign the host effect on skip", async () => {
    const event = await run({ action: "read", resources: ["src/a.ts"], effect: "ask" });
    expect(event.effect).toBe("ask");
  });

  it("assigns deny for sudo ls", async () => {
    const event = await run({ action: "shell", resources: ["sudo ls"], effect: "ask" });
    expect(event.effect).toBe("deny");
  });

  it("reads the program from plugin options", async () => {
    const event: PermissionEvaluation = { action: "shell", resources: ["rm -rf /tmp/x"], effect: "ask" };
    const ctx: PermissionHost = {
      options: { program: '"allow"' },
      permission: {
        hook: async (name, callback) => {
          expect(name).toBe("evaluate");
          await callback(event);
        },
      },
    };
    await register(ctx);
    expect(event.effect).toBe("allow");
  });

  it("a blocked resource denies and an empty call leaves the host effect", async () => {
    const blocked = await run({ action: "edit", resources: ["src/a.ts", ".env"], effect: "ask" });
    const empty = await run({ action: "shell", resources: [], effect: "ask" });
    expect({ blocked: blocked.effect, empty: empty.effect }).toEqual({ blocked: "deny", empty: "ask" });
  });
});
