// `display` IS A HOST AFFORDANCE, NOT A LANGUAGE FEATURE.
//
// Arrival has no `display` and must not: ports and IO are omitted BY DESIGN — it is a pure inference
// plane, and an ambient write has no value-construction site for provenance. That law does not bend,
// and nothing here bends it. Nothing writes anywhere. `display` returns its argument.
//
// But a model writes `(display x)` reflexively — it is the natural Scheme spelling of "show me
// this". Measured on the 89-task corpus: it cost a hard door and a wasted round on 32% OF TASKS, and
// in the trajectory that made it visible, the model tried `display`, ate the door, fell back, and
// eventually burned its budget without an answer.
//
// The door was CORRECT AND USELESS. It refused the SPELLING while the INTENT was perfectly
// serviceable: the model wants the value. So the HOST offers the verb and the language stays pure —
// take the materialization away from the caller, keep only their intent.
//
// THE SEMANTICS (V's ruling):
//   TOP-LEVEL `(display X)`     → PASS-THROUGH. The wrap is stripped from the AST before eval, so
//                                 X's value IS the statement's result. No echo — echoing the answer
//                                 beside itself is noise.
//   NESTED    `(f (display X))` → IDENTITY + a recorded echo, rendered after the statement's result,
//                                 carrying the ORIGINAL EXPRESSION:
//                                     #| (display (* 2 3)):  6 |#

import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

async function tool(): Promise<ManifoldTool> {
  const env = await buildManifoldEnv([
    {
      slug: "t",
      tools: [
        {
          name: "get",
          description: "returns a list",
          inputSchema: { type: "object", properties: {} },
          invoke: async () => "[1,2,3]",
        },
      ],
    },
  ]);
  return createManifoldTool(env, "C", { trace: env.trace });
}

const run = async (expr: string | string[]): Promise<string> => textOf(await (await tool()).call({ expr }));

describe("POSITIVE — the intent is honored", () => {
  it("TOP-LEVEL (display X): X's value IS the result, and there is NO echo beside it", async () => {
    const text = await run(`(display (list 1 2 3))`);
    expect(text).toContain("[1 2 3]");
    // The answer must not be repeated as an echo — that would be pure noise.
    expect(text).not.toContain("#| (display");
    // And above all: NOT the door it used to be.
    expect(text).not.toContain("not available");
    expect(text).not.toContain("ports & IO are omitted");
  });

  it("NESTED (display X): identity — composition is completely unaffected", async () => {
    // If display were anything but identity, this would not be 7.
    expect(await run(`(+ 1 (display (* 2 3)))`)).toContain("7");
  });

  it("NESTED (display X): the echo carries the ORIGINAL EXPRESSION and the value", async () => {
    const text = await run(`(+ 1 (display (* 2 3)))`);
    expect(text).toContain("#| (display (* 2 3)):  6 |#");
  });

  it("several displays in one statement stay DISTINGUISHABLE — which is why the expression is echoed", async () => {
    const text = await run(`(+ (display 10) (display 20))`);
    expect(text).toContain("30"); // identity held
    expect(text).toContain("#| (display 10):  10 |#");
    expect(text).toContain("#| (display 20):  20 |#");
  });

  it("the echo is a READER COMMENT — the model can paste the whole observation back as a no-op", async () => {
    const text = await run(`(+ 1 (display 5))`);
    // `#| … |#` parses to ZERO forms. An echo the model cannot safely re-submit would be a trap.
    expect(text).toMatch(/#\|.*\|#/s);
  });
});

// ─── THE NEGATIVE SIDE ────────────────────────────────────────────────────────────────────────
//
// The affordance rewrites the model's AST. A rewrite that reaches too far would silently change the
// meaning of a program the model wrote — strictly worse than the door it replaces, because the model
// would never learn that its code had been altered.
describe("NEGATIVE — the rewrite must not reach past `(display X)`", () => {
  it("a program with NO display is untouched", async () => {
    expect(await run(`(+ 1 2)`)).toContain("3");
  });

  it("`display` bound as a VALUE still hits arrival's door — we did not add an IO surface", async () => {
    // The rewrite only ever fires on a CALL FORM. A bare `display` is not one, and arrival's own
    // no-IO door correctly still teaches here. We made the spelling unnecessary; we did not make
    // the language impure.
    const text = await run(`(map display (list 1 2))`);
    expect(text).toContain("Error");
  });

  it("a SYMBOL merely named like a display argument is not rewritten", async () => {
    expect(await run([`(define displayed 42)`, `displayed`])).toContain("42");
  });

  it("a nested display inside a define still echoes, and the define still binds", async () => {
    const text = await run([`(define x (+ 1 (display 41)))`, `x`]);
    expect(text).toContain("#| (display 41):  41 |#");
    expect(text).toContain("42");
  });

  it("display over a real tool result composes — the value flows through untouched", async () => {
    const text = await run([`(define r (t/get))`, `(length (display r))`]);
    expect(text).toContain("#| (display r):"); // echoed
    expect(text).not.toContain("Error");
  });
});
