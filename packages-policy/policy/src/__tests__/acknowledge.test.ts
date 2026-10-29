import { describe, expect, it } from "vitest";

import {
  acknowledgeRequest,
  acknowledgeRequirement,
  blockReason,
  floorVerdictOf,
  mergeAcknowledge,
  parseAcknowledge,
  parseAcknowledgeText,
  requestAcknowledgement,
  type AckFlag,
  type AckSubject,
} from "../acknowledge.js";

const bash = (command: string): AckSubject => ({ tool: "bash", verdict: floorVerdictOf({ kind: "bash", command }) });

describe("acknowledgeRequirement", () => {
  const cases: readonly [string, AckFlag, AckSubject, boolean][] = [
    ["command prefix on an approved shell unit", { match: { command: ["git", "status"] } }, bash("git status"), true],
    ["command argv0 only", { match: { command: ["git"] } }, bash("git status"), true],
    ["command other program", { match: { command: ["git", "push"] } }, bash("git status"), false],
    ["command inside a pipeline", { match: { command: ["cat"] } }, bash("echo hi | cat"), true],
    ["class on an ask call", { match: { class: "package-install" } }, bash("npm install left-pad"), true],
    ["class does not match an approve", { match: { class: "package-install" } }, bash("git status"), false],
    ["tool name", { match: { tool: "send_email" } }, { tool: "send_email" }, true],
    ["tool name differs", { match: { tool: "send_email" } }, { tool: "bash" }, false],
    ["mcp server", { match: { mcp: "gmail" } }, { tool: "mcp__gmail__send_email" }, true],
    ["mcp server+tool", { match: { mcp: "gmail", tool: "send_email" } }, { tool: "mcp__gmail__send_email" }, true],
    ["mcp tool differs", { match: { mcp: "gmail", tool: "send_email" } }, { tool: "mcp__gmail__list" }, false],
    ["mcp explicit", { match: { mcp: "gmail", tool: "x" } }, { mcp: { server: "gmail", tool: "x" } }, true],
    [
      "mcp account",
      { match: { mcp: "gmail", account: "work" } },
      { mcp: { server: "gmail", account: "home", tool: "x" } },
      false,
    ],
  ];
  it.each(cases)("%s", (_name, flag, subject, expected) => {
    expect(acknowledgeRequirement([flag], subject) !== null).toBe(expected);
  });

  it("collects labels and whys without duplicates", () => {
    const requirement = acknowledgeRequirement(
      [
        { match: { tool: "bash" }, why: "shell" },
        { match: { command: ["git"] }, why: "shell" },
      ],
      bash("git status"),
    );
    expect(requirement).toEqual({ labels: ["tool bash", "command git"], why: ["shell"] });
    expect(blockReason(requirement!)).toBe("needs acknowledgement: tool bash, command git");
  });
});

describe("config", () => {
  it("parses and rejects", () => {
    expect(parseAcknowledge(undefined)).toEqual([]);
    expect(parseAcknowledge([{ match: { tool: "x" }, modes: ["auto"] }])).toHaveLength(1);
    expect(() => parseAcknowledge([{ match: { class: "nope" } }])).toThrow(/invalid acknowledge config/);
    expect(() => parseAcknowledge([{ match: { tool: "x" }, why: "x".repeat(201) }])).toThrow(/invalid/);
    expect(() => parseAcknowledge("x")).toThrow(/invalid/);
    expect(() => parseAcknowledgeText("{")).toThrow(/not json/);
    expect(parseAcknowledgeText('{"acknowledge":[{"match":{"tool":"x"}}]}')).toHaveLength(1);
    expect(parseAcknowledgeText("")).toEqual([]);
  });
  it("merges as a union: a project adds and never removes", () => {
    const user: AckFlag[] = [{ match: { tool: "a" } }];
    const project: AckFlag[] = [{ match: { tool: "b" } }, { match: { tool: "a" } }];
    expect(mergeAcknowledge(user, project)).toHaveLength(2);
    expect(mergeAcknowledge(user, [])).toEqual(user);
  });
});

describe("requestAcknowledgement", () => {
  const requirement = { labels: ["tool x"], why: ["because"] };
  it("encodes and truncates the agent text", () => {
    const request = acknowledgeRequest(requirement, "x", `a"b${"z".repeat(1000)}`);
    expect(request.detail.startsWith('"a\\"b')).toBe(true);
    expect(request.detail.length).toBeLessThan(510);
    expect(request.why).toBe("because");
  });
  it("accepted, declined, throwing, absent", async () => {
    expect(await requestAcknowledgement(requirement, "x", "t", async () => true)).toBeUndefined();
    expect(await requestAcknowledgement(requirement, "x", "t", async () => false)).toBe(
      "acknowledgement declined: tool x",
    );
    expect(
      await requestAcknowledgement(requirement, "x", "t", () => {
        throw new Error("boom");
      }),
    ).toBe("acknowledgement failed: tool x");
    expect(await requestAcknowledgement(requirement, "x", "t", undefined)).toBe("needs acknowledgement: tool x");
  });
});
