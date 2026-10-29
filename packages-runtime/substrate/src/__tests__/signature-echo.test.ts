// signature-echo — pure unit coverage of the detection logic (no MCP wiring); the
// e2e-through-a-real-manifold-server half (doors.ts's signatureEchoFor + DoorSession.echoSignature
// + manifold-tool.ts's catch hook + bind.ts's signatureByName + server.ts wiring) lives in the
// sibling arrival-manifold package. Measured problem: ~15% of eval errors are tool MISUSE (wrong
// kwarg name, dangling keyword, wrong arg type/shape) — the model gets the error but not the
// CONTRACT, so it guesses again. The manifold already holds every tool's one-line signature;
// echoing the relevant one below a misuse error teaches "this is how this symbol works". It is a
// SIBLING of the unbound did-you-mean enrichment, on the DISJOINT tool-misuse family — and it
// NEVER fires on a tool that ran and failed on domain grounds (its args were fine), nor on an
// unbound-variable wall.

import { describe, expect, it } from "vitest";

import type { BoundTool } from "../bound-tool.js";
import { DoorSession, implicatedTool, isToolMisuseError, signatureEchoFor } from "../doors.js";
import { synthesizeExampleCall } from "../example-call.js";

describe("isToolMisuseError — the argument/validation/kwarg shapes only", () => {
  it("matches kwargs, s/*, and upstream argument-rejection shapes", () => {
    expect(isToolMisuseError("kwargs call has a dangling keyword with no value — expected …")).toBe(true);
    expect(isToolMisuseError('s/number: expected a number, got string: "one"')).toBe(true);
    expect(isToolMisuseError("invalid arguments for add: a: Expected number, received string")).toBe(true);
    expect(isToolMisuseError("invalid arguments for add: 'a' is a required property")).toBe(true);
  });

  it("matches a downstream MCP server's own -32602 'Input validation error' rejection (the TS SDK's exact wording, both with and without the JSON-RPC frame server.ts strips)", () => {
    const zodIssues =
      '[{"code": "invalid_type", "expected": "object", "received": "string", "path": ["query"], ' +
      '"message": "Expected object, received string"}]';
    const stripped = `Input validation error: Invalid arguments for tool clinicaltrials_list_studies: ${zodIssues}`;
    const withFrame = `MCP error -32602: ${stripped}`;
    expect(isToolMisuseError(stripped)).toBe(true);
    expect(isToolMisuseError(withFrame)).toBe(true);
  });

  it("does NOT match execution/domain prose, the attestation door, or the unbound wall", () => {
    expect(isToolMisuseError("ValueError: database connection refused")).toBe(false);
    expect(isToolMisuseError("quota exhausted for today")).toBe(false);
    expect(isToolMisuseError("upstream exploded: repository not found (HTTP 404)")).toBe(false);
    expect(
      isToolMisuseError("tool argument :amount requires an explicit type assertion — wrap it: (s/number 37)"),
    ).toBe(false);
    expect(isToolMisuseError("Unbound variable `add'")).toBe(false);
  });
});

/** Test-only helper: builds a minimal `BoundTool` registry from explicit (slug, tool) pairs. */
function toolParts(entries: Record<string, { slug: string; tool: string }>): ReadonlyMap<string, BoundTool> {
  const map = new Map<string, BoundTool>();
  for (const [qualified, entry] of Object.entries(entries)) {
    map.set(qualified, {
      qualifiedName: qualified,
      slug: entry.slug,
      tool: entry.tool,
      signature: () => ({ params: [], signatureText: qualified }),
    });
  }
  return map;
}

describe("implicatedTool — pick the one tool, or skip when ambiguous", () => {
  const bound = ["toy/add", "toy/greet", "fs/read_file"];
  const boundParts = toolParts({
    "toy/add": { slug: "toy", tool: "add" },
    "toy/greet": { slug: "toy", tool: "greet" },
    "fs/read_file": { slug: "fs", tool: "read_file" },
  });

  it("one tool in the statement → that tool (message need not name it)", () => {
    expect(implicatedTool("(toy/add :a 1 :b)", "kwargs call has a dangling keyword …", bound, boundParts)).toBe(
      "toy/add",
    );
    expect(
      implicatedTool(
        '(toy/add :a (s/number "x") :b 2)',
        's/number: expected a number, got string: "x"',
        bound,
        boundParts,
      ),
    ).toBe("toy/add");
  });

  it("several tools → only the one the message uniquely names (bare or qualified)", () => {
    expect(
      implicatedTool(
        "(toy/add :a (toy/greet :name 5) :b 2)",
        "invalid arguments for greet: name: Expected string",
        bound,
        boundParts,
      ),
    ).toBe("toy/greet");
  });

  it("several tools, message names none → undefined (skip)", () => {
    expect(
      implicatedTool(
        '(toy/add :a (toy/greet :name "hi") :b)',
        "kwargs call has a dangling keyword …",
        bound,
        boundParts,
      ),
    ).toBeUndefined();
  });

  it("no bound tool in the statement → undefined (a bare validator call is not a tool)", () => {
    expect(
      implicatedTool('(s/number "x")', 's/number: expected a number, got string: "x"', bound, boundParts),
    ).toBeUndefined();
  });

  it("qualified names tokenize whole — a bare `add` substring never mis-binds toy/add", () => {
    // `read_file` present as its qualified token (SYMBOL_TOKEN's charset covers `/`, so
    // `fs/read_file` tokenizes whole); `toy/add` absent though the word `add` is in prose.
    expect(
      implicatedTool(
        '(fs/read_file :path "/x")',
        "invalid arguments for read_file: add is not a key",
        bound,
        boundParts,
      ),
    ).toBe("fs/read_file");
  });
});

describe("signatureEchoFor + DoorSession.echoSignature", () => {
  const sigs = new Map([["toy/add", "(toy/add :a number :b number) - Add"]]);
  const sigParts = toolParts({ "toy/add": { slug: "toy", tool: "add" } });

  it("returns the implicated tool + its signature on a misuse shape, undefined otherwise", () => {
    expect(signatureEchoFor("(toy/add :a 1 :b)", "kwargs call has a dangling keyword …", sigs, sigParts)).toEqual({
      tool: "toy/add",
      signatureText: "(toy/add :a number :b number) - Add",
    });
    // execution error → undefined; unbound → undefined; tool-less → undefined
    expect(signatureEchoFor("(toy/add :a 1 :b 2)", "ValueError: boom", sigs, sigParts)).toBeUndefined();
    expect(signatureEchoFor("(other_thing)", "kwargs call has a dangling keyword …", sigs, sigParts)).toBeUndefined();
  });

  it("echoSignature returns the below-line suffix and logs one telemetry line", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const suffix = session.echoSignature("toy/add", "(toy/add :a number :b number) - Add");
    expect(suffix).toBe("\nSignature: (toy/add :a number :b number) - Add");
    expect(JSON.parse(lines[0]!)).toEqual({ door: "envelope/signature-echo", seq: 1, tool: "toy/add" });
  });

  it("echoSignature appends an Example line when a synthesized example is supplied, without disturbing the telemetry shape", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const suffix = session.echoSignature("toy/add", "(toy/add :a number :b number) - Add", "(toy/add :a 0 :b 0)");
    expect(suffix).toBe("\nSignature: (toy/add :a number :b number) - Add\nExample: (toy/add :a 0 :b 0)");
    expect(JSON.parse(lines[0]!)).toEqual({ door: "envelope/signature-echo", seq: 1, tool: "toy/add" });
  });
});

describe("A — a downstream -32602 'Input validation error' gets a synthesized Example: line, not just Signature:", () => {
  it("end-to-end: signatureEchoFor implicates the tool, synthesizeExampleCall renders a real example off its schema, echoSignature appends BOTH lines", () => {
    const qualified = "clinicaltrials/list_studies";
    const schema = {
      type: "object" as const,
      properties: {
        query: {
          type: "object" as const,
          properties: { condition: { type: "string" as const } },
          required: ["condition"],
        },
      },
      required: ["query"],
    };
    const tools = new Map([
      [
        qualified,
        {
          qualifiedName: qualified,
          slug: "clinicaltrials",
          tool: "list_studies",
          schema,
          signature: () => ({ params: [], signatureText: `(${qualified} :query object) - List studies` }),
        },
      ],
    ]) as ReadonlyMap<string, BoundTool>;
    const sigs = new Map([[qualified, `(${qualified} :query object) - List studies`]]);

    const statement = `(${qualified} :query "condition:cancer")`;
    const zodIssues =
      '[{"code": "invalid_type", "expected": "object", "received": "string", "path": ["query"], ' +
      '"message": "Expected object, received string"}]';
    // The exact shape the model sees once server.ts's stripJsonRpcFrame drops the SDK's
    // "MCP error -32602: " plumbing frame (runner.ts's `raw` at the misuse-echo branch).
    const message = `Input validation error: Invalid arguments for tool ${qualified}: ${zodIssues}`;

    const echo = signatureEchoFor(statement, message, sigs, tools);
    expect(echo).toEqual({ tool: qualified, signatureText: `(${qualified} :query object) - List studies` });

    const example = synthesizeExampleCall(echo!.tool, tools.get(echo!.tool)?.schema);
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const suffix = session.echoSignature(echo!.tool, echo!.signatureText, example);
    expect(suffix).toContain("\nSignature: ");
    expect(suffix).toContain("\nExample: ");
    // Non-enum slot: the type-placeholder hole, never a
    // fabricated concrete value.
    expect(example).toBe(`(${qualified} :query {:condition #|string|#})`);
  });
});
