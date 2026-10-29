import { describe, expect, it } from "vitest";

import {
  canonicalKeep,
  DEFAULT_CONTEXT_RETENTION,
  decideRetentionStep,
  narrowRule,
  parseRetentionLayer,
  resolveRetention,
  ruleFor,
  sessionRetentionLayer,
  type StepFacts,
} from "../retention/index.js";
import { elideArgs, textRemainder, toolRemainder, type StubFacts } from "../retention/render.js";

describe("G10: narrowing algebra", () => {
  it("combines conditions as whichever comes first", () => {
    expect(narrowRule({ keep: ["turn", { rounds: 3 }] }, { keep: { rounds: 2 } }, "tool.read").keep).toEqual([
      "turn",
      { rounds: 2 },
    ]);
    expect(canonicalKeep(["compaction", { rounds: 5 }])).toEqual([{ rounds: 5 }]);
  });

  it("a longer horizon from a narrowing layer changes nothing", () => {
    const base = { keep: { rounds: 2 }, leave: "stub" } as const;
    expect(narrowRule(base, { keep: "forever" }, "tool.search")).toEqual({ keep: { rounds: 2 }, leave: "stub" });
  });

  it("leave: none is not allowed on a tool result", () => {
    expect(narrowRule({ leave: "summary" }, { leave: "none" }, "tool.shell").leave).toBe("summary");
    expect(narrowRule({ leave: "summary" }, { leave: "none" }, "thinking").leave).toBe("none");
  });

  it("project, agent and tool layers cannot touch user-authored kinds; session kv can narrow them", () => {
    const layer = { kinds: { steer: { keep: "round" } } } as const;
    const project = resolveRetention({ project: layer });
    expect(project.policy.kinds.steer).toEqual(DEFAULT_CONTEXT_RETENTION.kinds.steer);
    expect(project.ignored.join()).toContain("steer is user-authored");
    const session = resolveRetention({ session: layer });
    expect(session.policy.kinds.steer?.keep).toEqual("round");
  });

  it("a project layer cannot loosen; the user layer can", () => {
    const tighter = resolveRetention({ project: { kinds: { "tool.search": { keep: "forever" } } } });
    expect(tighter.policy.kinds["tool.search"]).toEqual(DEFAULT_CONTEXT_RETENTION.kinds["tool.search"]);
    expect(tighter.ignored.join()).toContain("does not shorten");
    const looser = resolveRetention({ user: { kinds: { "tool.search": { keep: "forever" } } } });
    expect(looser.policy.kinds["tool.search"]?.keep).toEqual("forever");
  });

  it("session kv and tool hints only shorten; a kind name beats the tool prefix", () => {
    expect(sessionRetentionLayer({ "retention.tool.read": '"round"', "retention.tool.mcp:x/y": "turn" })).toEqual({
      kinds: { "tool.read": { keep: ["round"] } },
      tools: { "mcp:x/y": { keep: ["turn"] } },
    });
    const { policy } = resolveRetention({});
    expect(ruleFor(policy, { kind: "tool.mcp", names: ["mcp:x/y"], hint: { keep: "round" } }).keep).toEqual(["turn", "round"]);
    expect(ruleFor(policy, { kind: "tool.mcp", names: ["mcp:x/y"], hint: { keep: "forever" } }).keep).toEqual(["turn"]);
  });

  it("per-tool overrides win over the kind, with longest glob first", () => {
    const { policy } = resolveRetention({
      user: { tools: { "mcp:github/*": { keep: { turns: 2 } }, "mcp:*": { keep: "round" }, read_file: { keep: "turn" } } },
    });
    expect(ruleFor(policy, { kind: "tool.mcp", names: ["mcp:github/search", "x"] }).keep).toEqual([{ turns: 2 }]);
    expect(ruleFor(policy, { kind: "tool.mcp", names: ["mcp:other/t", "x"] }).keep).toEqual(["round"]);
    expect(ruleFor(policy, { kind: "tool.read", names: ["read_file"] }).keep).toEqual(["turn"]);
  });

  it("an invalid field is dropped, not fatal", () => {
    const layer = parseRetentionLayer(
      JSON.stringify({
        step: { everyRounds: 0, minFreedTokens: 100 },
        kinds: { "tool.read": { keep: "never" }, "tool.shell": { keep: { rounds: 5 } }, bogus: { keep: "turn" } },
      }),
    );
    expect(layer).toEqual({ step: { minFreedTokens: 100 }, kinds: { "tool.shell": { keep: { rounds: 5 } } } });
  });
});

const facts = (over: Partial<StepFacts> = {}): StepFacts => ({
  self: "c5",
  step: { turnBoundary: true, everyRounds: 4, minFreedTokens: 8000, whenCacheCold: true, atCompaction: true },
  prior: { at: "c1", warmUntilMs: 2_000 },
  turnFirstRound: false,
  afterCutoff: false,
  roundsSinceAt: 1,
  now: 1_000,
  freedTokens: () => 0,
  ...over,
});

describe("G5-G7: the retention clock", () => {
  it("steps in order: compaction, turn, cold, every, freed; otherwise holds", () => {
    expect(decideRetentionStep(facts({ afterCutoff: true, turnFirstRound: true })).reason).toBe("compaction");
    expect(decideRetentionStep(facts({ turnFirstRound: true })).reason).toBe("turn");
    expect(decideRetentionStep(facts({ now: 2_500 }))).toEqual({ at: "c5", reason: "cold", coldByMs: 500 });
    expect(decideRetentionStep(facts({ roundsSinceAt: 4 })).reason).toBe("every");
    expect(decideRetentionStep(facts({ freedTokens: () => 9000 }))).toEqual({ at: "c5", reason: "freed", freedTokens: 9000 });
    expect(decideRetentionStep(facts())).toEqual({ at: "c1", reason: "hold" });
  });

  it("G6: steps every N rounds, and only when enough would be freed", () => {
    const sequence: string[] = [];
    let at = "c0";
    for (let round = 1; round <= 9; round += 1) {
      const clock = decideRetentionStep(
        facts({
          self: `c${round}`,
          prior: { at, warmUntilMs: null },
          roundsSinceAt: round - Number(at.slice(1)),
          // 3 KB shell results free roughly 750 tokens per round since the last step.
          freedTokens: () => (round - Number(at.slice(1))) * 3000,
          step: { turnBoundary: true, everyRounds: null, minFreedTokens: 8000, whenCacheCold: false, atCompaction: true },
        }),
      );
      sequence.push(`${round}:${clock.reason}`);
      at = clock.at;
    }
    expect(sequence).toEqual(["1:hold", "2:hold", "3:freed", "4:hold", "5:hold", "6:freed", "7:hold", "8:hold", "9:freed"]);
  });

  it("an unknown warm deadline is not cold", () => {
    expect(decideRetentionStep(facts({ prior: { at: "c1", warmUntilMs: null }, now: 9e9 })).reason).toBe("hold");
  });
});

const stub = (over: Partial<StubFacts> = {}): StubFacts => ({
  tool: "read_file",
  kind: "tool.read",
  ref: "job:abcd1234",
  args: { path: "src/a.ts" },
  full: "line\n".repeat(411),
  ok: true,
  value: undefined,
  code: undefined,
  ...over,
});

describe("remainders are deterministic", () => {
  it("stub, summary, head", () => {
    expect(toolRemainder("stub", stub(), false)).toBe(
      "[read_file elided: src/a.ts, 412 lines, 2.0 KB — re-read or recall job:abcd1234]",
    );
    expect(toolRemainder("summary", stub({ tool: "grep", kind: "tool.search", ok: false, code: "E", full: "boom\nmore" }), true)).toBe(
      "[grep failed (E): boom — recall job:abcd1234]",
    );
    expect(toolRemainder({ head: 4 }, stub({ full: "abcdefgh" }), false)).toMatch(/^abcd\n\[read_file elided: /);
    expect(textRemainder("none", "steer", "x")).toBeNull();
    expect(textRemainder("stub", "steer", "hello")).toBe("[steer elided: 5 chars]");
  });

  it("elided arguments stay valid JSON and keep short fields", () => {
    const out = elideArgs({ path: "a.ts", content: "x".repeat(3000) }, "job:abcd1234#args", 2000);
    expect(JSON.parse(out.json)).toEqual({
      path: "a.ts",
      content: "[elided: 1 lines, 2.9 KB — recall job:abcd1234#args]",
    });
    expect(elideArgs({ path: "a.ts", content: "x".repeat(300) }, "r", 2000).elided).toBe(false);
  });
});
