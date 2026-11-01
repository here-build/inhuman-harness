import { KernelPlexus, KernelRoot, SessionPlexus, layersOf, type GrantRow } from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import type { DecodedKeyEvent } from "@inhuman.tools/quickdraw/runtime";
import { expect, test, vi } from "vitest";

import { classResolution, explainLines, parseProbe, permissionsView } from "../permissions-view.js";
import { Tea } from "../tea.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const DAY = 86_400_000;

function row(id: string, kind: "grant" | "ack", scope: GrantRow["scope"], expiresAtMs: number | null): GrantRow {
  return {
    id,
    kind,
    scope,
    scopeKey: "",
    subject: { kind: "tool", name: "send_email" },
    createdAtMs: NOW - DAY,
    expiresAtMs,
    source: "prompt",
    label: `tool ${id}`,
  };
}

const LAYERS = layersOf({
  user: JSON.stringify({
    auto: { classes: { publish: "human" } },
    acknowledge: [{ match: { mcp: "gmail", tool: "send_email" }, why: "emails leave the company" }],
  }),
  project: "",
  session: "",
});

test("the view names the mode, a resolver per class with its layer badge, and the flags with theirs", () => {
  const view = permissionsView({ mode: "auto", layers: LAYERS, grants: [], acks: [], nowMs: NOW });
  const text = view.lines.join("\n");
  expect(view.lines[0]).toBe("Mode: auto");
  expect(text).toMatch(/Publishes\s+\S.*\[(dist|user)\] \/ \S.*\[(dist|user)\]/);
  expect(view.lines.filter((line) => /\[(dist|user|project|session)\] \//.test(line))).toHaveLength(20);
  expect(text).toContain("mcp gmail/send_email [user] — emails leave the company");
  const publish = classResolution(LAYERS, "auto", "publish", "ask");
  expect(publish).toEqual({ resolver: { kind: "human" }, layer: "user" });
  expect(text).toContain("Publishes");
});

test("grants and acks list scope, label, created and expiry; each can be revoked by its own RPC", () => {
  const view = permissionsView({
    mode: "manual",
    layers: LAYERS,
    grants: [row("g1", "grant", "project", NOW + 7 * DAY)],
    acks: [row("a1", "ack", "session", null)],
    nowMs: NOW,
  });
  const text = view.lines.join("\n");
  expect(text).toContain("project tool g1 · created 2026-10-24 · expires 2026-11-01 (7 days) · prompt");
  expect(text).toContain("session tool a1 · created 2026-10-24 · expires when the session ends · prompt");
  expect(view.revocable.map((r) => [r.revoke.method, r.revoke.params, r.detail])).toEqual([
    ["grant/revoke", { id: "g1" }, "grant · project · 2026-11-01 (7 days)"],
    ["ack/revoke", { id: "a1" }, "acknowledgement · session · when the session ends"],
  ]);
});

test("explain parses a probe and shows the outcome with the ack info", () => {
  expect([
    parseProbe("mcp:gmail/send_email"),
    parseProbe("read ~/x"),
    parseProbe("./a.ts"),
    parseProbe("git push"),
    parseProbe("  "),
  ]).toEqual([
    { kind: "mcp", server: "gmail", tool: "send_email" },
    { kind: "path", cluster: "read", path: "~/x" },
    { kind: "path", cluster: "write", path: "./a.ts" },
    { kind: "shell", command: "git push" },
    null,
  ]);
  const view = permissionsView({
    mode: "auto",
    layers: LAYERS,
    grants: [],
    acks: [],
    nowMs: NOW,
    explain: {
      probe: "mcp:gmail/send_email",
      outcome: {
        tier: "allow",
        outcome: "prompts-you",
        reason: "Allowed, but flagged.",
        resolver: null,
        ack: {
          flags: [{ label: "gmail · send_email", why: "emails leave the company", layer: "user" }],
          satisfiedBy: null,
        },
      },
    },
  });
  expect(view.lines.slice(-5)).toEqual([
    "  mcp:gmail/send_email",
    "  allow → prompts-you",
    "  Allowed, but flagged.",
    "  Needs acknowledgement: gmail · send_email",
    '  "emails leave the company" [user]',
  ]);
  expect(
    explainLines({
      tier: "ask",
      outcome: "runs",
      reason: "r",
      resolver: { kind: "allow", layer: "dist" },
      ack: null,
    })[0],
  ).toBe("ask → runs · allow [dist]");
});

test("/permissions loads the lists and Enter on a stored row revokes it over RPC", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
  let revoked = false;
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "grant/list") return { rows: revoked ? [] : [row("g1", "grant", "project", NOW + DAY)] };
    if (method === "ack/list") return { rows: [] };
    return { ok: true };
  };
  using tea = new Tea(client, () => undefined);
  const key = (k: string, mods: Omit<DecodedKeyEvent, "key"> = {}) =>
    tea.handle({ kind: "input_events", events: [{ key: k, ...mods }] });
  tea.handle({ kind: "input_events", events: [..."/permissions"].map((k) => ({ key: k })) });
  key("Enter");
  await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["grant/list", "ack/list"]));
  key("ArrowDown");
  revoked = true;
  key("Enter");
  await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain("grant/revoke"));
  expect(calls.find((c) => c.method === "grant/revoke")?.params).toEqual({ id: "g1" });
  await vi.waitFor(() => expect(calls.filter((c) => c.method === "grant/list")).toHaveLength(2));
});

test("flags read as words, and the class column fits the longest label", () => {
  const layers = layersOf({
    user: JSON.stringify({
      acknowledge: [
        { match: { command: ["date"] }, why: "test flag" },
        { match: { class: "publish" } },
        { match: { tool: "x" } },
      ],
    }),
    project: "",
    session: "",
  });
  const lines = permissionsView({ mode: "auto", layers, grants: [], acks: [], nowMs: NOW }).lines;
  const text = lines.join("\n");
  expect(text).toContain("`date` [user] — test flag");
  expect(text).toContain("class: Publishes [user]");
  expect(text).toContain("tool: x [user]");
  expect(text).not.toContain('{"command"');
  const rows = lines.filter((line) => /\[(dist|user|project|session)\] \//.test(line));
  expect(rows).toHaveLength(20);
  // Every resolver starts in the same column, and the longest label keeps a gap before it.
  const starts = new Set(rows.map((line) => line.search(/ (allow|ask|human|deny|judge)/)));
  expect(starts.size).toBe(1);
  expect(rows.some((line) => line.startsWith("  Changes the controls on the agent "))).toBe(true);
});
