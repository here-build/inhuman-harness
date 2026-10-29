import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decideHook, hookOptionsFromEnv } from "../hook.js";

const flag = (match: object) => ({ match }) as never;
const bash = (command: string) => ({ tool_name: "bash", tool_input: { command } });
const allow = () => "allow" as const;

describe("crush acknowledgement", () => {
  const options = { acknowledgeFlags: [flag({ command: ["git", "status"] })] };

  it("a flagged floor-approved call leaves the decision to Crush's prompt instead of allowing", async () => {
    expect(await decideHook(bash("git status"), allow, options)).toBeUndefined();
    expect(await decideHook(bash("pwd"), allow, options)).toEqual({ decision: "allow" });
    expect(await decideHook(bash("npm install x"), allow, options)).toEqual({ decision: "allow" });
  });

  it("applies to a judge-allowed call", async () => {
    const flagged = { acknowledgeFlags: [flag({ class: "package-install" })] };
    expect(await decideHook(bash("npm install left-pad"), allow, flagged)).toBeUndefined();
  });

  it("denials and blocks are unchanged, with and without yolo", async () => {
    const flagged = { acknowledgeFlags: [flag({ tool: "bash" })], yolo: true };
    expect(await decideHook(bash("rm .env"), allow, flagged)).toEqual({ decision: "deny", reason: "not authorized" });
    expect(await decideHook(bash("rm file"), () => "deny", flagged)).toEqual({
      decision: "deny",
      reason: "not authorized",
    });
  });

  it("--yolo denies a flagged call with a clear reason and leaves unflagged calls alone", async () => {
    const yolo = { ...options, yolo: true };
    expect(await decideHook(bash("git status"), allow, yolo)).toEqual({
      decision: "deny",
      reason: "needs acknowledgement: command git status (Crush is running with --yolo, so the host cannot ask you)",
    });
    expect(await decideHook(bash("npm install x"), allow, yolo)).toEqual({ decision: "allow" });
    expect(await decideHook(bash("pwd"), allow, yolo)).toEqual({ decision: "allow" });
  });

  it("a tool flag reaches a tool the gate does not model", async () => {
    const flagged = { acknowledgeFlags: [flag({ mcp: "gmail" })] };
    const call = { tool_name: "mcp__gmail__send_email", tool_input: {} };
    expect(await decideHook(call, allow, flagged)).toBeUndefined();
    expect(await decideHook(call, allow, { ...flagged, yolo: true })).toMatchObject({ decision: "deny" });
  });

  it("an unparseable config denies every call", async () => {
    expect(await decideHook(bash("pwd"), allow, { configError: "invalid acknowledge config: x" })).toEqual({
      decision: "deny",
      reason: "invalid acknowledge config: x",
    });
  });
});

describe("hookOptionsFromEnv", () => {
  function setup() {
    const home = mkdtempSync(path.join(tmpdir(), "crush-ack-"));
    const cwd = path.join(home, "proj");
    mkdirSync(path.join(home, ".config", "crush"), { recursive: true });
    mkdirSync(path.join(cwd, ".crush"), { recursive: true });
    return { home, cwd, raw: JSON.stringify({ cwd }) };
  }

  it("unions user and project flags and reads CRUSH_YOLO", () => {
    const { home, cwd, raw } = setup();
    writeFileSync(path.join(home, ".config", "crush", "policy-acknowledge.json"), '[{"match":{"tool":"a"}}]');
    writeFileSync(path.join(cwd, ".crush", "policy-acknowledge.json"), '{"acknowledge":[{"match":{"tool":"b"}}]}');
    const options = hookOptionsFromEnv({ CRUSH_YOLO: "1" }, raw, home);
    expect(options.yolo).toBe(true);
    expect(options.acknowledgeFlags).toHaveLength(2);
  });

  it("a project file cannot remove a user flag", () => {
    const { home, cwd, raw } = setup();
    writeFileSync(path.join(home, ".config", "crush", "policy-acknowledge.json"), '[{"match":{"tool":"a"}}]');
    writeFileSync(path.join(cwd, ".crush", "policy-acknowledge.json"), "[]");
    expect(hookOptionsFromEnv({}, raw, home).acknowledgeFlags).toHaveLength(1);
  });

  it("an invalid file reports a config error", () => {
    const { home, raw } = setup();
    writeFileSync(path.join(home, ".config", "crush", "policy-acknowledge.json"), '[{"match":{"class":"nope"}}]');
    expect(hookOptionsFromEnv({}, raw, home).configError).toMatch(/invalid acknowledge config/);
  });
});
