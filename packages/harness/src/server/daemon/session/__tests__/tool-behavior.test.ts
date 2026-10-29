import { McpToolExpectation, MCPToolJob, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { type ToolOutcome, Dict, toJS, type Val } from "@/extensions";
import { guardedCallOf, guardedOutcomeJson, scopedPath } from "@/tool-runtime";

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
