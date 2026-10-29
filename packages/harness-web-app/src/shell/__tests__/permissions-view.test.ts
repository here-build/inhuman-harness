import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExplainResult, PermissionsBody } from "../permissions-panel.js";
import { resolverWords } from "@inhuman.tools/harness-model/session";
import {
  cellText,
  explain,
  explainLines,
  expiryText,
  loadPermissions,
  parseProbe,
  permissionsView,
  revokeRequest,
  revokeRow,
  type PermissionsData,
} from "../permissions-view.js";

const NOW = Date.UTC(2026, 9, 25);
const row = (over: Record<string, unknown>) => ({
  id: "g1",
  scope: "project",
  scopeKey: "/p",
  subject: { kind: "tool", name: "x" },
  createdAtMs: NOW - 86_400_000,
  expiresAtMs: NOW + 6 * 86_400_000,
  source: "prompt",
  label: "tool x",
  ...over,
});

const data = (over: Partial<PermissionsData> = {}): PermissionsData => ({
  mode: "auto",
  layers: {
    user: JSON.stringify({
      auto: { classes: { publish: { ask: "deny" } } },
      acknowledge: [{ match: { mcp: "gmail", tool: "send_email" }, why: "emails leave the company" }],
    }),
    project: "",
    session: "",
  },
  warnings: [],
  grants: [row({}) as never],
  acks: [row({ id: "a1", kind: "ack", scope: "session", expiresAtMs: null, label: "gmail · send_email" }) as never],
  nowMs: NOW,
  ...over,
});

describe("cell wording", () => {
  it("spells out what a judge no and a judge failure fall to", () => {
    const judge = (onDeny: "human" | "deny", onFail: "human" | "deny") =>
      ({ kind: "judge", params: {}, onDeny, onFail }) as never;
    expect(cellText(judge("deny", "human"))).toBe("judge · no: deny · fails: ask you");
    expect(cellText(judge("human", "human"))).toBe("judge, else ask you");
    expect(resolverWords(judge("deny", "human")).full).toBe("Judge · if it says no: deny · if it fails: ask you");
    expect(cellText({ kind: "human" })).toBe("ask you");
  });
});

describe("permissionsView", () => {
  it("resolves every class for ask and soft-deny with its layer", () => {
    const view = permissionsView(data());
    expect(view.mode).toBe("auto");
    expect(view.classes.length).toBeGreaterThan(15);
    const publish = view.classes.find((c) => c.id === "publish")!;
    expect(publish.ask).toMatchObject({ kind: "deny", layer: "user" });
    const other = view.classes.find((c) => c.id === "workspace-write")!;
    expect(other.cluster).toBe("write");
    expect(other.ask.layer).toBe("dist");
    expect(view.classes.find((c) => c.id === "mcp-action")!.cluster).toBe("mcp");
  });

  it("lists the flags in force with their layer", () => {
    expect(permissionsView(data()).flags).toEqual([
      { label: "gmail · send_email", why: "emails leave the company", layer: "user" },
    ]);
  });

  it("shows expiry and revocability of stored rows", () => {
    const view = permissionsView(data());
    expect(view.grants[0]).toMatchObject({
      scope: "project",
      expires: "in 6 days",
      revocable: true,
      created: "2026-10-24",
    });
    expect(view.acks[0]).toMatchObject({ kind: "ack", expires: "until the session ends" });
    const file = permissionsView(data({ grants: [row({ source: "settings", expiresAtMs: null }) as never] }));
    expect(file.grants[0]).toMatchObject({ expires: "no expiry", revocable: false });
    expect(expiryText({ scope: "global", expiresAtMs: NOW - 1 }, NOW)).toBe("expired");
    expect(expiryText({ scope: "global", expiresAtMs: NOW + 2 * 3_600_000 }, NOW)).toBe("in 2 h");
  });

  it("paints modes, badges, rows and a revoke button", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionsBody, { view: permissionsView(data()), busy: false, onRevoke: () => undefined }),
    );
    expect(html).toContain('permissions-mode">auto');
    expect(html).toContain('data-layer="user"');
    expect(html).toContain('data-layer="dist"');
    expect(html).toContain("in 6 days");
    expect(html).toContain("Revoke tool x");
    expect(html).toContain("emails leave the company");
  });
});

describe("revoke", () => {
  it("picks the method by kind and names the session for session rows", () => {
    expect(revokeRequest({ id: "g1", kind: "grant", scope: "project" }, "s1")).toEqual({
      method: "grant/revoke",
      params: { id: "g1" },
    });
    expect(revokeRequest({ id: "a1", kind: "ack", scope: "session" }, "s1")).toEqual({
      method: "ack/revoke",
      params: { id: "a1", sessionId: "s1" },
    });
  });

  it("sends it and reports the daemon's answer", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    expect(await revokeRow(request, { id: "a1", kind: "ack", scope: "global" }, null)).toBe(true);
    expect(request).toHaveBeenCalledWith("ack/revoke", { id: "a1" });
    expect(await revokeRow(async () => ({ ok: false }), { id: "a1", kind: "ack", scope: "global" }, null)).toBe(false);
  });
});

describe("loadPermissions", () => {
  it("reads layers from the session and rows from the kernel", async () => {
    const session = vi.fn(async () => ({ layers: { user: "{}", project: "", session: "" }, warnings: ["w"] }));
    const kernel = vi.fn(async (method: string) => ({ rows: method === "grant/list" ? [row({})] : [] }));
    const loaded = await loadPermissions({
      session,
      kernel,
      sessionId: "s1",
      projectPath: "/p",
      mode: "manual",
      nowMs: NOW,
    });
    expect(session).toHaveBeenCalledWith("policy/config-get", {});
    expect(kernel).toHaveBeenCalledWith("grant/list", { sessionId: "s1", projectPath: "/p" });
    expect(kernel).toHaveBeenCalledWith("ack/list", { sessionId: "s1", projectPath: "/p" });
    expect(loaded).toMatchObject({ mode: "manual", warnings: ["w"] });
    expect(loaded.grants).toHaveLength(1);
  });

  it("degrades to empty with a warning when a call throws", async () => {
    const loaded = await loadPermissions({
      session: null,
      kernel: async () => {
        throw new Error("down");
      },
      sessionId: null,
      projectPath: null,
      mode: undefined,
      nowMs: NOW,
    });
    expect(loaded.mode).toBe("auto");
    expect(loaded.warnings).toEqual(["Grants: down", "Acknowledgements: down"]);
  });
});

describe("explain", () => {
  it("reads a command, a path and an mcp tool", () => {
    expect(parseProbe("git push origin main")).toEqual({ kind: "shell", command: "git push origin main" });
    expect(parseProbe("~/.ssh/config")).toEqual({ kind: "path", cluster: "write", path: "~/.ssh/config" });
    expect(parseProbe("read:/etc/hosts")).toEqual({ kind: "path", cluster: "read", path: "/etc/hosts" });
    expect(parseProbe("mcp:gmail/send_email")).toEqual({ kind: "mcp", server: "gmail", tool: "send_email" });
    expect(parseProbe("  ")).toBeNull();
  });

  it("asks policy/explain and shows outcome, reason and ack", async () => {
    const reply = {
      outcome: "prompts-you",
      reason: "gmail.send_email needs your acknowledgement.",
      tier: "allow",
      classes: [],
      resolver: null,
      grant: null,
      ack: { flags: [{ label: "gmail · send_email", why: "emails leave", layer: "user" }], satisfiedBy: null },
    };
    const request = vi.fn(async () => reply);
    const lines = await explain(request, "mcp:gmail/send_email", "auto");
    expect(request).toHaveBeenCalledWith("policy/explain", {
      probe: { kind: "mcp", server: "gmail", tool: "send_email" },
      mode: "auto",
    });
    expect(lines).toMatchObject({
      outcome: "Asks you",
      ack: "gmail · send_email — emails leave · needs acknowledgement",
    });
    const html = renderToStaticMarkup(createElement(ExplainResult, { lines: explainLines(reply)! }));
    expect(html).toContain("needs your acknowledgement");
    expect(explainLines("nope")).toBeNull();
  });
});
