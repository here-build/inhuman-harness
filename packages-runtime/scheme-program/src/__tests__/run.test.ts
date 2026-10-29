/** runProgram: argument doors, form results, display, source jail, runtime identity. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvCapability } from "@here.build/arrival";
import { arrivalLoaderCapability } from "@here.build/arrival-modules";
import { ProgrammaticJob } from "@inhuman.tools/harness-model";
import { REPL_PERIOD_ERR } from "@inhuman.tools/harness-model/schemas";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { describe, expect, it } from "vitest";

import { type ProgramHost } from "../host.js";
import { SCHEME_REPL_DISPLAY_NOTE, SCHEME_REPL_UNWRAP_NOTES } from "../notes.js";
import { runProgram } from "../run.js";
import { programRuntimeOf } from "../runtime.js";
import { programSourceLoader } from "../source-fs.js";

const boomCapability = EnvCapability.define("test/scheme-program-boom", {
  symbols: (declare, sz) => ({
    boom: declare.native`boom: throws`({ input: [], output: [sz.schemeValue] }, () => {
      throw new Error("boom: nope");
    }),
  }),
});

function outcomeOf(chunk: ProgrammaticJob): {
  ok: boolean;
  text?: string;
  value?: unknown;
  json?: unknown;
  jsonError?: string;
} {
  return JSON.parse(chunk.receiptJson ?? "null") as {
    ok: boolean;
    text?: string;
    value?: unknown;
    json?: unknown;
    jsonError?: string;
  };
}

function job(args: unknown, id = "r1"): ProgrammaticJob {
  const argsJson =
    typeof args === "string" ? args : JSON.stringify({ description: "test", ...(args as Record<string, unknown>) });
  return new ProgrammaticJob({ toolCallId: id, argsJson });
}

function host(extra: Partial<ProgramHost> = {}): ProgramHost {
  return {
    identity: extra.identity ?? {},
    signal: extra.signal,
    doors: extra.doors ?? new DoorSession(() => {}),
    root: extra.root ?? "/tmp",
    evalProgram: extra.evalProgram,
    moduleRoot: extra.moduleRoot,
    tools: extra.tools ?? (() => new Map()),
    prepare:
      extra.prepare ??
      (() => ({
        capabilities: [],
        config: {},
      })),
  };
}

function sourceHost(root: string, evalProgram: boolean): ProgramHost {
  return host({
    root,
    evalProgram,
    prepare(opts) {
      const jail = opts.moduleRoot ?? root;
      return {
        capabilities: [arrivalLoaderCapability],
        config: { loader: programSourceLoader(jail), dirname: "" },
      };
    },
  });
}

describe("runProgram", () => {
  it("rejects a bad argument bag, an empty expr, and period", async () => {
    const repl = host();
    const empty = job({});
    const raw = job("(+ 1 2)");
    const zeroTimeout = job({ expr: "(+ 1 2)", timeoutMs: 0 });
    const blank = job({ expr: "" });
    const period = job({ expr: "(+ 1 2)", period: "1 minutes" });
    const captioned = job({ expr: "(+ 1 2)", description: "Add one and two" });
    await Promise.all([empty, raw, zeroTimeout, blank, period, captioned].map((chunk) => runProgram(chunk, repl)));
    expect({
      empty: outcomeOf(empty),
      raw: outcomeOf(raw),
      zeroTimeout: outcomeOf(zeroTimeout),
      blank: outcomeOf(blank).text,
      period: outcomeOf(period).text,
      captioned: outcomeOf(captioned),
    }).toEqual({
      empty: { ok: false, text: "Error: expr must be a string" },
      raw: { ok: false, text: "Error: arguments must be a JSON object" },
      zeroTimeout: { ok: false, text: "Error: timeoutMs must be >= 1" },
      blank: expect.stringMatching(/expr is empty/i),
      period: `Error: ${REPL_PERIOD_ERR}`,
      captioned: { ok: true, value: ["3"] },
    });
  });

  it("evaluates forms, unwraps top-level wrappers, and does not leak defines", async () => {
    const repl = host();
    // A ProgrammaticJob is thenable. Return it from async and the caller awaits the job, not the bag.
    async function run(expr: string, id: string): Promise<{ chunk: ProgrammaticJob }> {
      const chunk = job({ expr }, id);
      await runProgram(chunk, repl);
      return { chunk };
    }
    const defined = await run("(define x 41) (+ x 1)", "defined");
    const later = await run("x", "later");
    const wrapped = await run("(begin (+ 1 2) (+ 3 4))", "wrapped");
    const listed = await run("(list (+ 1 2) (+ 3 4))", "listed");
    const vector = await run("[(+ 1 2) (+ 3 4)]", "vector");
    const mixed = await run("(list (begin (+ 1 2)) [(+ 3 4)])", "mixed");
    const nestedBegin = await run("(if #t (begin 1 2))", "nested");
    const dotted = await run("(cons 'a 1)", "dotted");
    const printed = await run('(+ 1 2)\n(string-append "hello" " " "world")', "printed");
    expect({
      defined: outcomeOf(defined.chunk),
      later: outcomeOf(later.chunk).text,
      wrapped: outcomeOf(wrapped.chunk),
      listed: outcomeOf(listed.chunk),
      vector: outcomeOf(vector.chunk),
      mixed: outcomeOf(mixed.chunk),
      nestedBegin: outcomeOf(nestedBegin.chunk),
      dotted: outcomeOf(dotted.chunk),
      printed: outcomeOf(printed.chunk),
    }).toEqual({
      defined: { ok: true, value: ["42"] },
      later: expect.stringMatching(/unbound/i),
      wrapped: { ok: true, value: [SCHEME_REPL_UNWRAP_NOTES.begin, "3", "7"] },
      listed: { ok: true, value: [SCHEME_REPL_UNWRAP_NOTES.list, "3", "7"] },
      vector: { ok: true, value: [SCHEME_REPL_UNWRAP_NOTES.vector, "3", "7"] },
      mixed: {
        ok: true,
        value: [
          SCHEME_REPL_UNWRAP_NOTES.list,
          SCHEME_REPL_UNWRAP_NOTES.begin,
          SCHEME_REPL_UNWRAP_NOTES.vector,
          "3",
          "7",
        ],
      },
      nestedBegin: { ok: true, value: ["2"] },
      dotted: { ok: true, value: ["[a 1]"] },
      printed: { ok: true, value: ["3", "hello world"] },
    });
  });

  it("a failed define does not cascade into a second unbound-variable fault", async () => {
    const chunk = job({ expr: "(define bad (boom)) (* bad 2)" });
    await runProgram(
      chunk,
      host({
        prepare: () => ({ capabilities: [boomCapability], config: {} }),
      }),
    );
    const outcome = outcomeOf(chunk);
    expect({ ok: outcome.ok, text: outcome.text }).toEqual({
      ok: false,
      text: expect.stringMatching(/boom: nope/),
    });
    expect(outcome.text).not.toMatch(/Unbound variable/);
  });

  it("display: top-level passes through, nested echoes beside the result", async () => {
    const repl = host();
    const top = job({ expr: '(display "hello")' }, "top");
    const nested = job({ expr: "(length (display (list 1 2 3)))" }, "nested");
    const mixed = job({ expr: '(+ 1 2) (display "showme") (* 3 4)' }, "mixed");
    await Promise.all([top, nested, mixed].map((chunk) => runProgram(chunk, repl)));
    const nestedValues = outcomeOf(nested).value as unknown[];
    const mixedValues = outcomeOf(mixed).value as unknown[];
    expect({
      top: outcomeOf(top),
      nested: nestedValues.map((value) => (typeof value === "string" ? value : "")),
      mixed: mixedValues.map((value) => (typeof value === "string" ? value : "")),
    }).toEqual({
      top: { ok: true, value: [`${SCHEME_REPL_DISPLAY_NOTE}\nhello`] },
      nested: ["3", expect.stringMatching(/^#\| \(display \(list 1 2 3\)\):.*\|#$/)],
      mixed: ["3", `${SCHEME_REPL_DISPLAY_NOTE}\nshowme`, "12"],
    });
  });

  it("unterminated dict literal teaches a no-comma retry", async () => {
    const chunk = job({
      expr: '(read_file "packages/harness/src/eval/__tests__/eval-cli.test.ts" {offset: 90',
    });
    await runProgram(chunk, host());
    const outcome = outcomeOf(chunk);
    expect({
      ok: outcome.ok,
      diagnosis: outcome.text?.includes("unterminated dict literal '{'"),
      retry: outcome.text?.includes("{offset: 90 limit: 40}"),
      balance: outcome.text?.includes("check bracket balance"),
      sampler: outcome.text,
    }).toEqual({
      ok: false,
      diagnosis: true,
      retry: true,
      balance: false,
      sampler: expect.stringMatching(/sampler/i),
    });
  });

  it("loads source in two phases, returns structured json, and jails require", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scheme-program-source-"));
    const sub = join(parent, "sub");
    await mkdir(sub);
    const sourcePath = join(sub, "main.scm");
    await writeFile(sourcePath, ";; entry\n");
    await writeFile(join(parent, "lib.scm"), "(define (inc n) (+ n 1))\n");
    await writeFile(join(parent, "n.json"), '{"n": 7}\n');
    const interactive = sourceHost(parent, false);
    const program = sourceHost(parent, true);

    const doubled = job({ source: "(define (double x) (* x 2))", sourcePath, expr: "(double 21)" }, "doubled");
    const blocked = job({ source: "(not-bound)", sourcePath, expr: "99" }, "blocked");
    const missingPath = job({ source: "(define leaked 1)", expr: "(+ 1 2)" }, "missing-path");
    const ignored = job({ source: "(not-bound)", sourcePath, expr: "(+ 2 3)" }, "ignored");
    const scalar = job({ expr: "#t" }, "scalar");
    const dict = job({ expr: "{ :passed #t :repairs 0 }" }, "dict");
    const loaded = job({ expr: '(require "lib.scm") (inc 40)' }, "loaded");
    const jsonFile = job({ expr: '(require "n.json")' }, "json");
    const escaped = job({ expr: '(require "../lib.scm")', sourcePath }, "escaped");

    await runProgram(doubled, program);
    await runProgram(blocked, program);
    await runProgram(missingPath, program);
    await runProgram(ignored, interactive);
    await runProgram(scalar, program);
    await runProgram(dict, program);
    await runProgram(loaded, interactive);
    await runProgram(jsonFile, interactive);
    await runProgram(escaped, program);

    const scalarOutcome = outcomeOf(scalar);
    expect({
      doubled: outcomeOf(doubled),
      blocked: outcomeOf(blocked).text,
      blockedValue: outcomeOf(blocked).value,
      missingPath: outcomeOf(missingPath).text,
      ignored: outcomeOf(ignored),
      scalar: scalarOutcome,
      scalarJson: "json" in scalarOutcome,
      dict: outcomeOf(dict),
      loaded: outcomeOf(loaded),
      jsonFile: outcomeOf(jsonFile),
      escaped: outcomeOf(escaped).text,
    }).toEqual({
      doubled: { ok: true, value: ["42"] },
      blocked: expect.stringMatching(/Unbound|unbound|not-bound/),
      blockedValue: undefined,
      missingPath: "Error: source requires sourcePath",
      ignored: { ok: true, value: ["5"] },
      scalar: { ok: true, value: ["#t"] },
      scalarJson: false,
      dict: { ok: true, value: [expect.any(String)], json: { passed: true, repairs: 0 } },
      loaded: { ok: true, value: ["41"] },
      jsonFile: { ok: true, value: ["{:n 7}"] },
      escaped: expect.stringMatching(/escape|jail|\.\.|no such file/i),
    });
  });

  it("remints a runtime after park and rejects a live second host", () => {
    const chunk = new ProgrammaticJob({ toolCallId: "wrap", argsJson: "{}" });
    const park = new AbortController();
    const first = host({ signal: park.signal });
    const armed = programRuntimeOf(chunk, first);
    let live: unknown;
    try {
      live = programRuntimeOf(chunk, host());
    } catch (error) {
      live = error instanceof Error ? error.message : String(error);
    }
    park.abort("park");
    const leftover = programRuntimeOf(chunk, host());
    expect({ live, leftoverNew: leftover !== armed }).toEqual({
      live: expect.stringMatching(/rebound to a different host/),
      leftoverNew: true,
    });
  });
});
