import { McpToolExpectation, MCPToolJob, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, onTestFinished, test } from "vitest";

import { AgentBehavior, BehaviorKernel, loadProgram, type ToolOutcome, Dict, toJS, type Val } from "@/extensions";
import { Lambda } from "@/extensions/value";
import { guardHostTool, guardedCallOf, guardedOutcomeJson, scopedPath, stampUnentered } from "@/tool-runtime";

function system(name: string, args: object): SystemToolJob {
  return new SystemToolJob({
    toolCallId: name,
    name,
    argsJson: JSON.stringify(args),
  });
}

function narrow(job: SystemToolJob | MCPToolJob, value: (raw: Val) => Val) {
  const call = guardedCallOf(job, "/work")!;
  const next = call.argsFor(value(call.raw));
  return {
    point: call.point,
    paths: call.paths,
    raw: toJS(call.raw),
    next: "error" in next ? next.error : next.args,
  };
}

function outcome(patch: Partial<ToolOutcome>): ToolOutcome {
  return {
    entered: true,
    result: false,
    refusal: "",
    failure: "",
    diagnostics: [],
    hookFailures: [],
    guardFailure: "",
    marks: [],
    attempts: 1,
    deliveries: [],
    originAtoms: [],
    ...patch,
  };
}

test("host tool calls map to guard points, and narrowed values write back into their arguments", () => {
  const mcp = new MCPToolJob({
    toolCallId: "m1",
    name: "mcp__memory__commit",
    argsJson: JSON.stringify({ text: "fact" }),
    connectionKey: "memory",
    serverToolName: "commit",
    expectation: new McpToolExpectation({
      connectionId: "memory",
      serverToolName: "commit",
      argsJson: "{}",
    }),
  });
  expect({
    write: narrow(
      system("write_file", {
        path: "/work/src/a.ts",
        content: "x",
        overwriteExisting: true,
      }),
      () => new Dict({ paths: ["src/b.ts"], contents: "y" }),
    ),
    writeTwo: narrow(
      system("write_file", { path: "a", content: "x" }),
      () => new Dict({ paths: ["a", "b"], contents: "x" }),
    ),
    edit: narrow(
      system("edit_file", {
        path: "./src/a.ts",
        old_string: "a",
        new_string: "b",
      }),
      () => new Dict({ old: "a", new: "c" }),
    ),
    glob: narrow(system("glob", { pattern: "*.ts", cwd: "lib" }), () => "src"),
    mcp: narrow(
      mcp,
      () =>
        new Dict({
          server: "memory",
          tool: "commit",
          opts: new Dict({ text: "redacted" }),
        }),
    ),
    reroute: narrow(mcp, () => new Dict({ server: "other", tool: "commit", opts: new Dict({}) })),
    pack: guardedCallOf(system("fixture_offload", {}), "/work"),
    outside: scopedPath("/work", "/etc/passwd"),
  }).toEqual({
    write: {
      point: "write",
      paths: ["src/a.ts"],
      raw: { paths: ["/work/src/a.ts"], contents: "x" },
      next: { path: "src/b.ts", content: "y", overwriteExisting: true },
    },
    writeTwo: expect.objectContaining({
      next: "a write guard must pass exactly one path",
    }),
    edit: {
      point: "edit",
      paths: ["src/a.ts"],
      raw: { old: "a", new: "b" },
      next: { path: "./src/a.ts", old_string: "a", new_string: "c" },
    },
    glob: {
      point: "read",
      paths: ["lib"],
      raw: "lib",
      next: { pattern: "*.ts", cwd: "src" },
    },
    mcp: {
      point: "mcp",
      paths: ["memory/commit"],
      raw: { server: "memory", tool: "commit", opts: { text: "fact" } },
      next: { text: "redacted" },
    },
    reroute: expect.objectContaining({
      next: "an mcp guard may not reroute the call",
    }),
    pack: null,
    outside: "/etc/passwd",
  });
});

test("guards replace or refuse a receipt; hook diagnostics follow its text", () => {
  const receipt = JSON.stringify({ ok: true, text: "a\nb" });
  expect({
    same: guardedOutcomeJson(receipt, outcome({ result: "a\nb" })),
    replaced: guardedOutcomeJson(receipt, outcome({ result: "[redacted]" })),
    refused: guardedOutcomeJson(receipt, outcome({ refusal: "too late" })),
    annotated: guardedOutcomeJson(receipt, outcome({ result: "a\nb", diagnostics: ["watched"] })),
    failed: guardedOutcomeJson(
      JSON.stringify({ ok: false, text: "boom" }),
      outcome({ failure: "boom", diagnostics: ["noted"] }),
    ),
  }).toEqual({
    same: receipt,
    replaced: JSON.stringify({ ok: true, text: "[redacted]" }),
    refused: JSON.stringify({ ok: false, text: "too late" }),
    annotated: JSON.stringify({ ok: true, text: "a\nb\n\nwatched" }),
    failed: JSON.stringify({ ok: false, text: "boom\n\nnoted" }),
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

/** A real Scheme plugin callback supplied to the host's guard protocol. */
async function shellGuard(suspend?: Promise<void>) {
  const registry = await loadProgram({
    agentId: "guard-agent",
    source: `(define/tool 'callback :handler (lambda (command invoke) (invoke command)))`,
    filename: "/plugin/guard.scm",
    revision: "fixture",
    root: "/plugin",
    kind: "behavior",
    read: () => {
      throw new Error("unexpected import");
    },
  });
  const original = registry.tools.get("callback")!.handler;
  const handler =
    suspend == null
      ? original
      : new Lambda(async (...args) => {
          await suspend;
          return original.call(...args);
        }, original.source);
  registry.guards.push({
    point: "shell",
    matchers: [],
    guardCapability: "narrow",
    contract: "",
    handler,
    reentrantDepth: 0,
    hash: "fixture",
    program: "guard.scm",
    declarationId: "guard:shell",
    source: original.source,
  });
  return new AgentBehavior(
    "guard-agent",
    [{ plugin: "fixture", bot: "foreground", registry, bindings: new Map() }],
    new BehaviorKernel({ packages: () => [] }),
  );
}

test("a suspended plugin guard denies at its deadline and cannot license a tool when it eventually invokes", async () => {
  const gate = deferred<void>();
  onTestFinished(() => gate.resolve());
  const agent = await shellGuard(gate.promise);
  const job = system("shell", { command: "effect" });
  let licensed = 0;
  const decision = await guardHostTool({
    job,
    agent,
    origin: "model",
    behaviorEntries: [],
    turnId: "turn",
    hookTimeoutMs: 20,
    guardedCall: (leaf) => guardedCallOf(leaf, "/work"),
    license: async () => {
      licensed += 1;
      return true;
    },
    onUnentered: stampUnentered,
  });
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect({ allowed: decision.allowed, licensed, receipt: job.outcomeSnap, args: job.args }).toEqual({
    allowed: false,
    licensed: 0,
    receipt: { ok: false, text: "plugin guard failed: plugin guard deadline exceeded" },
    args: { command: "effect" },
  });
});

test.each(["approve", "abort"] as const)(
  "plugin execution time excludes a human license wait, then honors %s",
  async (answer) => {
    const permission = deferred<boolean>();
    const licensing = deferred<void>();
    onTestFinished(() => permission.resolve(false));
    const controller = new AbortController();
    const agent = await shellGuard();
    const job = system("shell", { command: "effect" });
    let settled = false;
    const waiting = guardHostTool({
      job,
      agent,
      origin: "model",
      behaviorEntries: [],
      turnId: "turn",
      hookTimeoutMs: 20,
      signal: controller.signal,
      guardedCall: (leaf) => guardedCallOf(leaf, "/work"),
      license: () => {
        licensing.resolve();
        return permission.promise;
      },
      onUnentered: stampUnentered,
    }).then((decision) => {
      settled = true;
      return decision;
    });
    await licensing.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect({ settled, receipt: job.outcomeSnap ?? null }).toEqual({ settled: false, receipt: null });
    if (answer === "abort") controller.abort("park");
    permission.resolve(true);
    const decision = await waiting;
    if (decision.opened != null) await decision.opened.finish({ ok: true, value: "original effect receipt" });
    expect({ allowed: decision.allowed, receipt: job.outcomeSnap ?? null }).toEqual({
      allowed: answer === "approve",
      receipt: null,
    });
  },
);
