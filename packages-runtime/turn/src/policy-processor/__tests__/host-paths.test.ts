/**
 * Host half of the floor: symlinks resolve before the verdict (stricter wins), and
 * `web_extract` is an exfiltration channel that asks.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SystemToolJob } from "@inhuman.tools/harness-model";
import { bindPolicy, reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { read, TIMEOUT, write } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";
import { resolvedWorkspacePath } from "../real-path.js";
import { selfProtectedRoots, withSelfProtection } from "../self-protect.js";

async function stamped(job: { policyResult: unknown }): Promise<void> {
  await when(() => job.policyResult !== null, { timeout: TIMEOUT });
}

function fixture(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "floor-links-")));
  writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  writeFileSync(path.join(root, "plain.txt"), "x\n");
  mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  symlinkSync(".env", path.join(root, "notes.txt"));
  symlinkSync(".git/hooks", path.join(root, "linked-hooks"));
  symlinkSync("/etc", path.join(root, "etc-link"));
  symlinkSync("plain.txt", path.join(root, "alias.txt"));
  return root;
}

describe("resolvedWorkspacePath", () => {
  it("spells the real target against the real root", async () => {
    const root = fixture();
    expect(await resolvedWorkspacePath(root, "notes.txt")).toBe(".env");
    expect(await resolvedWorkspacePath(root, "linked-hooks/pre-commit")).toBe(".git/hooks/pre-commit");
    expect(await resolvedWorkspacePath(root, "plain.txt")).toBeUndefined();
    expect(await resolvedWorkspacePath(root, "not/yet/there.txt")).toBeUndefined();
  });
});

describe("symlinks in file tools", () => {
  it("a link to a read_block file is judged as the target", async () => {
    const root = fixture();
    using bag = setup({ policy: "manual", policyProgram: reasonableDefaultsSource, path: root });
    const viaLink = read("notes.txt");
    const plain = read("plain.txt");
    const viaAlias = read("alias.txt");
    const outside = read("etc-link/passwd");
    for (const job of [viaLink, plain, viaAlias, outside]) bag.enqueue(job);
    await Promise.all([viaLink, plain, viaAlias, outside].map((job) => stamped(job)));
    expect([viaLink.policyResult, plain.policyResult, viaAlias.policyResult, outside.policyResult]).toEqual([
      "block",
      "policyApprove",
      "policyApprove",
      "deny",
    ]);
  });

  it("a write through a linked directory (new file) is judged as the target", async () => {
    const root = fixture();
    using bag = setup({ policy: "manual", policyProgram: reasonableDefaultsSource, path: root });
    const hook = write("linked-hooks/pre-commit");
    const via = write("notes.txt");
    bag.enqueue(hook);
    bag.enqueue(via);
    await Promise.all([stamped(hook), stamped(via)]);
    expect([hook.policyResult, via.policyResult]).toEqual(["block", "block"]);
  });
});

describe("web_extract", () => {
  it("asks; web_search stays approved", async () => {
    using bag = setup({ policy: "manual", policyProgram: reasonableDefaultsSource });
    const extract = new SystemToolJob({
      toolCallId: "we-1",
      name: "web_extract",
      argsJson: JSON.stringify({ url: "https://example.test/?q=SECRET" }),
    });
    const search = new SystemToolJob({
      toolCallId: "ws-1",
      name: "web_search",
      argsJson: JSON.stringify({ query: "x" }),
    });
    bag.enqueue(extract);
    bag.enqueue(search);
    await Promise.all([stamped(extract), stamped(search)]);
    expect([extract.policyResult, search.policyResult]).toEqual(["ask", "policyApprove"]);
  });
});

describe("self-protection", () => {
  const roots = selfProtectedRoots({}, "/Users/me");
  const policy = bindPolicy(withSelfProtection(JSON.parse(reasonableDefaultsSource), roots));

  it("names the real gate locations", () => {
    expect(roots).toEqual(["/Users/me/.harness", "/Users/me/.inhuman", "/Users/me/.pi/agent"]);
    expect(selfProtectedRoots({ PI_CODING_AGENT_DIR: "/opt/pi", INHUMAN_HOME: "/opt/ih" }, "/Users/me")).toEqual([
      "/Users/me/.harness",
      "/Users/me/.inhuman",
      "/opt/ih",
      "/opt/pi",
    ]);
  });

  it.each([
    "/Users/me/.harness/policy.json",
    "/Users/me/.harness/commands/x.scm",
    "/Users/me/.inhuman/bots/x.md",
    "/Users/me/.pi/agent/policy-pi.json",
    "/Users/me/.pi/agent/policy-pi-authorize.scm",
    "/Users/me/.HARNESS/policy.json",
    ".pi/policy-pi.json",
  ])("blocks writes to %s", (p) => expect(policy.write(p)).toBe("block"));

  it.each([
    "packages-policy/policy/authorize.scm",
    "src/policy.json",
    "policy.json",
    "src/.harness/x.ts",
    "packages-runtime/turn/policy/auto-mode-ask.scm",
  ])("leaves the same-named repo file %s alone", (p) => expect(policy.write(p)).toBe("ask"));

  it("a document with no write cluster is unchanged", () => {
    expect(withSelfProtection({ bash: "approve" }, roots)).toEqual({ bash: "approve" });
  });
});
