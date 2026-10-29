import { describe, expect, it } from "vitest";

import { type AuthorizationConfig, CLASS_IDS, parseAuthorizationConfig } from "../config.js";
import { layersOf } from "../layers.js";
import { type CallQuery, type Layers, type Resolution, type Resolver, resolveCall, strictest } from "../resolve.js";

const cfg = (value: unknown): AuthorizationConfig => {
  const parsed = parseAuthorizationConfig(value);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.config;
};

const query = (over: Partial<CallQuery> = {}): CallQuery => ({
  mode: "manual",
  cluster: "bash",
  tier: "deny",
  classes: ["publish"],
  unattended: false,
  ...over,
});

const resolve = (layers: Layers, over: Partial<CallQuery> = {}): Resolution => resolveCall(layers, query(over));

/** "allow" | "human" | "deny" | "judge->H" (onDeny human, onFail human) | "judge->D" ... */
function show(resolver: Resolver): string {
  if (resolver.kind !== "judge") return resolver.kind;
  const tail = (v: string) => (v === "deny" ? "D" : "H");
  return `judge(deny:${tail(resolver.onDeny)},fail:${tail(resolver.onFail)})`;
}

describe("dist defaults (truth table)", () => {
  const MODES = ["manual", "auto", "yolo"] as const;
  const CLUSTERS = ["bash", "read", "write", "mcp"] as const;
  const TIERS = ["deny", "ask"] as const;

  const expected = (mode: (typeof MODES)[number], tier: (typeof TIERS)[number], unattended: boolean): string => {
    if (mode === "yolo") return "allow";
    if (mode === "manual") return unattended ? "deny" : "human";
    // auto: soft-deny judge, then a human; the ask judge, a judge deny is final.
    if (tier === "deny") return unattended ? "judge(deny:D,fail:D)" : "judge(deny:H,fail:H)";
    return unattended ? "judge(deny:D,fail:D)" : "judge(deny:D,fail:H)";
  };

  for (const mode of MODES) {
    for (const tier of TIERS) {
      for (const unattended of [false, true]) {
        it(`${mode} · ${tier === "deny" ? "soft-deny" : "ask"} · ${unattended ? "unattended" : "watching"}`, () => {
          for (const cluster of CLUSTERS) {
            // Every class resolves the same by default: credential and control-plane go to the judge too.
            for (const cls of CLASS_IDS) {
              const res = resolve({}, { mode, tier, cluster, classes: [cls], unattended });
              expect(show(res.resolver)).toBe(expected(mode, tier, unattended));
            }
          }
        });
      }
    }
  }

  it("unattended manual or auto: whatever needed a person is denied as interaction_required", () => {
    const human = resolve({}, { mode: "manual", unattended: true });
    expect(human.interaction.resolver).toBe(true);
    const judged = resolve({}, { mode: "auto", unattended: true });
    expect(judged.interaction).toEqual({ resolver: false, onDeny: true, onFail: true });
    // The ask judge's deny is already final: it is a policy denial, not a missing person.
    expect(resolve({}, { mode: "auto", tier: "ask", unattended: true }).interaction).toEqual({
      resolver: false,
      onDeny: false,
      onFail: true,
    });
  });

  it("yolo never asks anyone and has nothing to interact with", () => {
    const res = resolve({}, { mode: "yolo", unattended: true });
    expect(res.resolver).toEqual({ kind: "allow" });
    expect(res.interaction).toEqual({ resolver: false, onDeny: false, onFail: false });
  });
});

describe("config grammar", () => {
  it("accepts the owner's example literally and normalizes ask to human", () => {
    const layers: Layers = { user: cfg({ auto: { shell: { "soft-deny": "ask", ask: "judge" } } }) };
    expect(show(resolve(layers, { mode: "auto", tier: "deny" }).resolver)).toBe("human");
    expect(show(resolve(layers, { mode: "auto", tier: "ask" }).resolver)).toBe("judge(deny:D,fail:H)");
  });
  it("shell is bash", () => {
    const layers: Layers = { user: cfg({ manual: { shell: { ask: "allow" } } }) };
    expect(resolve(layers, { tier: "ask", cluster: "bash" }).resolver.kind).toBe("allow");
    expect(resolve(layers, { tier: "ask", cluster: "read" }).resolver.kind).toBe("human");
  });
  it("rejects risky/general, unknown classes and unknown keys", () => {
    expect(parseAuthorizationConfig({ auto: { risky: "ask" } }).ok).toBe(false);
    expect(parseAuthorizationConfig({ auto: { shell: { general: "judge" } } }).ok).toBe(false);
    expect(parseAuthorizationConfig({ auto: { classes: { "made-up": "allow" } } }).ok).toBe(false);
    expect(parseAuthorizationConfig({ nope: 1 }).ok).toBe(false);
    expect(parseAuthorizationConfig("{ not json").ok).toBe(false);
    expect(parseAuthorizationConfig({ rules: [{ match: { class: "publish" }, resolve: {} }] }).ok).toBe(false);
  });
  it("an empty layer is valid", () => {
    expect(parseAuthorizationConfig("")).toEqual({ ok: true, config: {} });
  });
  it("lookup order: cluster class > class > cluster tier > default", () => {
    const layers: Layers = {
      user: cfg({
        manual: {
          default: "human",
          classes: { publish: "deny" },
          bash: { "soft-deny": "judge", classes: { publish: "allow" } },
          write: { "soft-deny": "judge" },
        },
      }),
    };
    expect(resolve(layers, { cluster: "bash", classes: ["publish"] }).resolver.kind).toBe("allow");
    expect(resolve(layers, { cluster: "mcp", classes: ["publish"] }).resolver.kind).toBe("deny");
    expect(resolve(layers, { cluster: "write", classes: ["privilege"] }).resolver.kind).toBe("judge");
    expect(resolve(layers, { cluster: "read", classes: ["privilege"] }).resolver.kind).toBe("human");
  });
  it("a multi-class call takes the strictest class", () => {
    const layers: Layers = { user: cfg({ manual: { classes: { publish: "allow", privilege: "deny" } } }) };
    expect(resolve(layers, { classes: ["publish", "privilege"] }).resolver.kind).toBe("deny");
  });
});

describe("layering and monotonicity", () => {
  it("user loosens dist; session loosens user; project can only tighten", () => {
    const user = cfg({ manual: { default: "allow" } });
    expect(resolve({ user }).resolver.kind).toBe("allow");
    const session = cfg({ manual: { default: "judge" } });
    expect(resolve({ user, session }).resolver.kind).toBe("judge");
    // a project file asking for allow does not loosen the dist human
    expect(resolve({ project: cfg({ manual: { default: "allow" } }) }).resolver.kind).toBe("human");
    // and tightens the user's allow to what it asks for
    expect(resolve({ user, project: cfg({ manual: { default: "deny" } }) })).toMatchObject({
      resolver: { kind: "deny" },
      layer: "project",
    });
  });
  it("the session overlay is capped by the project layer", () => {
    const layers: Layers = {
      project: cfg({ manual: { classes: { publish: "deny" } } }),
      session: cfg({ manual: { default: "allow" } }),
    };
    expect(resolve(layers, { classes: ["publish"] }).resolver.kind).toBe("deny");
    expect(resolve(layers, { classes: ["privilege"] }).resolver.kind).toBe("allow");
  });
  it("an unparseable project file tightens every cell to a person", () => {
    const text = layersOf({ user: JSON.stringify({ yolo: { default: "allow" } }), project: "{ nope", session: "" });
    expect(text.projectInvalid).toBe(true);
    expect(resolve(text, { mode: "yolo" }).resolver.kind).toBe("human");
    // a deny the user configured is not loosened by it
    const strict = layersOf({ user: JSON.stringify({ yolo: { default: "deny" } }), project: "{", session: "" });
    expect(resolve(strict, { mode: "yolo" }).resolver.kind).toBe("deny");
  });
  it("an unparseable user block asks a person everywhere instead of being dropped", () => {
    const broken = layersOf({ user: '{"yolo": {"risky": "allow"}}', project: "", session: "" });
    expect(broken.userInvalid).toBe(true);
    for (const mode of ["manual", "auto", "yolo"] as const) {
      expect(resolve(broken, { mode }).resolver.kind).toBe("human");
    }
    expect(resolve(broken, { mode: "yolo" })).toMatchObject({ layer: "user" });
    // a fixed block is believed again
    expect(
      resolve(layersOf({ user: '{"yolo": {"default": "allow"}}', project: "", session: "" }), { mode: "yolo" }).resolver
        .kind,
    ).toBe("allow");
    // and unattended it is a denial
    expect(resolve(broken, { mode: "yolo", unattended: true })).toMatchObject({ resolver: { kind: "deny" } });
  });
  it("a managed set beats user and session; a managed require only tightens", () => {
    const layers: Layers = {
      managedSet: cfg({ manual: { default: "judge" } }),
      user: cfg({ manual: { default: "allow" } }),
      session: cfg({ manual: { default: "allow" } }),
    };
    expect(resolve(layers).resolver.kind).toBe("judge");
    expect(resolve({ ...layers, managedRequire: cfg({ manual: { default: "human" } }) }).resolver.kind).toBe("human");
    expect(resolve({ managedRequire: cfg({ manual: { default: "allow" } }) }).resolver.kind).toBe("human");
  });
  it("no table can produce block, and nothing is looser than deny", () => {
    const res = resolve({ user: cfg({ manual: { default: "deny" } }) });
    expect(res.resolver).toEqual({ kind: "deny" });
    expect(strictest({ kind: "deny" }, { kind: "allow" })).toEqual({ kind: "deny" });
    expect(strictest({ kind: "allow" }, { kind: "human" })).toEqual({ kind: "human" });
    expect(strictest({ kind: "human" }, { kind: "judge", params: {}, onDeny: "human", onFail: "human" }).kind).toBe(
      "human",
    );
  });
  it("judge cells merge field by field to the stricter", () => {
    const a = { kind: "judge", params: { margin: 2, rounds: 2 }, onDeny: "human", onFail: "human" } as const;
    const b = {
      kind: "judge",
      params: { margin: 0, rounds: 1, requireQuote: true },
      onDeny: "deny",
      onFail: "human",
    } as const;
    expect(strictest(a, b)).toEqual({
      kind: "judge",
      params: { margin: 0, rounds: 1, requireQuote: true },
      onDeny: "deny",
      onFail: "human",
    });
  });
});

describe("presets and unattended overlay", () => {
  it("auto full-auto judges everywhere and every failure denies", () => {
    const layers: Layers = { user: cfg({ auto: { preset: "full" } }) };
    for (const tier of ["deny", "ask"] as const) {
      expect(show(resolve(layers, { mode: "auto", tier }).resolver)).toBe("judge(deny:D,fail:D)");
    }
    const manualHuman = cfg({ auto: { preset: "full", classes: { credential: "human" } } });
    expect(show(resolve({ user: manualHuman }, { mode: "auto", classes: ["credential"] }).resolver)).toBe(
      "judge(deny:D,fail:D)",
    );
  });
  it("the preset cannot be enabled by a project file", () => {
    expect(show(resolve({ project: cfg({ auto: { preset: "full" } }) }, { mode: "auto" }).resolver)).toBe(
      "judge(deny:H,fail:H)",
    );
  });
  it("the unattended overlay replaces the base choice, then human becomes deny", () => {
    const layers: Layers = { user: cfg({ unattended: { classes: { privilege: "allow" } } }) };
    expect(resolve(layers, { mode: "auto", unattended: true, classes: ["privilege"] }).resolver.kind).toBe("allow");
    expect(resolve(layers, { mode: "auto", unattended: false, classes: ["privilege"] }).resolver.kind).toBe("judge");
    expect(resolve({}, { mode: "manual", unattended: true }).resolver.kind).toBe("deny");
  });
});

describe("specific entries", () => {
  const rules = cfg({
    rules: [
      { match: { mcp: "gmail", tool: "send_email" }, resolve: { manual: "deny", auto: "deny", yolo: "deny" } },
      { match: { mcp: "notion" }, resolve: { manual: "allow" } },
      { match: { command: ["make", "deploy"] }, resolve: { auto: "human" } },
      { match: { tool: "web_extract" }, resolve: { manual: "judge" } },
      { match: { path: "../shared", cluster: "read" }, resolve: { manual: "allow" } },
    ],
  });
  const mcp = (server: string, tool: string, account = server) => ({ mcp: { server, account, tool } });

  it("an MCP entry beats the class cell and is the only thing that can deny in yolo", () => {
    expect(
      resolve({ user: rules }, { mode: "yolo", cluster: "mcp", tier: "ask", subject: mcp("gmail", "send_email") })
        .resolver.kind,
    ).toBe("deny");
    expect(
      resolve({ user: rules }, { mode: "yolo", cluster: "mcp", tier: "ask", subject: mcp("gmail", "list") }).resolver
        .kind,
    ).toBe("allow");
    expect(resolve({ user: rules }, { cluster: "mcp", tier: "ask", subject: mcp("notion", "x") }).resolver.kind).toBe(
      "allow",
    );
  });
  it("the account is part of the match", () => {
    const user = cfg({
      rules: [{ match: { mcp: "gmail", account: "work", tool: "send" }, resolve: { manual: "allow" } }],
    });
    expect(
      resolve({ user }, { cluster: "mcp", tier: "ask", subject: mcp("gmail", "send", "work") }).resolver.kind,
    ).toBe("allow");
    expect(
      resolve({ user }, { cluster: "mcp", tier: "ask", subject: mcp("gmail", "send", "home") }).resolver.kind,
    ).toBe("human");
  });
  it("a command entry must cover every voting unit and matches by family prefix", () => {
    const unit = (argv0: string, spine: string[], familyArgs: string[]) => ({ argv0, spine, familyArgs });
    const hit = { units: [unit("make", [], ["deploy"])] };
    expect(resolve({ user: rules }, { mode: "auto", tier: "ask", subject: hit }).resolver.kind).toBe("human");
    const mixed = { units: [unit("make", [], ["deploy"]), unit("curl", [], [])] };
    expect(resolve({ user: rules }, { mode: "auto", tier: "ask", subject: mixed }).resolver.kind).toBe("judge");
    const other = { units: [unit("make", [], ["test"])] };
    expect(resolve({ user: rules }, { mode: "auto", tier: "ask", subject: other }).resolver.kind).toBe("judge");
  });
  it("tool and path entries", () => {
    expect(
      resolve({ user: rules }, { tier: "ask", cluster: "mcp", subject: { tool: "web_extract" } }).resolver.kind,
    ).toBe("judge");
    const inside = { paths: [{ cluster: "read" as const, path: "../shared/a/b.txt" }] };
    expect(resolve({ user: rules }, { cluster: "read", subject: inside }).resolver.kind).toBe("allow");
    const outside = { paths: [{ cluster: "read" as const, path: "../shared2/x" }] };
    expect(resolve({ user: rules }, { cluster: "read", subject: outside }).resolver.kind).toBe("human");
  });
  it("a project entry can only tighten", () => {
    const project = cfg({ rules: [{ match: { mcp: "notion" }, resolve: { manual: "allow" } }] });
    expect(resolve({ project }, { cluster: "mcp", tier: "ask", subject: mcp("notion", "x") }).resolver.kind).toBe(
      "human",
    );
  });
});
