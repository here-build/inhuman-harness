// AN ALIST IN AN OBJECT-DECLARED SLOT IS A DICT — the contract selects the chart.
//
// Reported (real trajectory): a model wrote the ordinary Scheme spelling of a keyed argument —
//
//     (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query (list (cons 'term "cancer")))
//
// and the tool received  [["term","cancer"]]  — a nested ARRAY, because a pair-spine projects to an
// array. The upstream refused it ("[[\"'term\", 'cancer']] is not of type 'object'"). The model then
// spent several rounds reasoning about quoting ("the single quote before term is being kept as part
// of the key"), tried string keys, and finally rediscovered our Clojure-style `{:term "cancer"}`
// literal by trial and error.
//
// Rounds spent relearning OUR notation, not doing the task. The medium made the model pay for our
// spelling — which is the whole thing this work exists to stop.
//
// THE FIX IS THE SAME LAW AS EVERYTHING ELSE: THE CONTRACT SELECTS THE CHART. The tool DECLARES
// `:query` is an object. An alist arriving in that slot is unambiguous — it is a caller spelling a
// dict the way Scheme spells one. So we read it as the slot says, and ONLY there.
//
// IT IS NOT A PROMOTION OF ALISTS (V's ruling: "we teach the system to treat an alist AS a dict —
// not to treat dicts as lists, not to promote alists; tolerance and affordance, not general
// design"). The outbound projection of a pair-spine is untouched: a list of pairs is still an array
// of arrays everywhere else, because everywhere else nothing has claimed otherwise.

import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

/** A tool with one OBJECT param, one ARRAY param, and one SCALAR param — so the negative cases have
 *  somewhere to land. `got()` is what the upstream ACTUALLY received. */
async function world() {
  let got: unknown;
  const env = await buildManifoldEnv([
    {
      slug: "ct",
      tools: [
        {
          name: "list_studies",
          description: "search studies",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "object", properties: { term: { type: "string" } } },
              fields: { type: "array", items: { type: "string" } },
              pageSize: { type: "number" },
            },
          },
          invoke: async (a: unknown) => {
            got = a;
            return "ok";
          },
        },
      ],
    },
  ]);
  return { tool: createManifoldTool(env, "C", { trace: env.trace }), got: () => got };
}

const sent = async (expr: string): Promise<unknown> => {
  const w = await world();
  await w.tool.call({ expr });
  return w.got();
};

describe("POSITIVE — an alist in an object-declared slot crosses as a dict", () => {
  it('the reported trace: (list (cons \'term "cancer")) reaches the tool as {term: cancer}', async () => {
    expect(await sent(`(ct/list_studies :query (list (cons 'term "cancer")))`)).toEqual({
      query: { term: "cancer" },
    });
  });

  it("multi-entry alists work", async () => {
    expect(await sent(`(ct/list_studies :query (list (cons 'term "cancer") (cons 'cond "lung")))`)).toEqual({
      query: { term: "cancer", cond: "lung" },
    });
  });

  it("the dict literal STILL works — the affordance is additive, not a replacement", async () => {
    expect(await sent(`(ct/list_studies :query {:term "cancer"})`)).toEqual({ query: { term: "cancer" } });
  });
});

// ─── THE NEGATIVE SIDE ────────────────────────────────────────────────────────────────────────
//
// This is the half that matters. A false positive here does not throw — it SILENTLY RESHAPES THE
// CALLER'S DATA, which is strictly worse than the error it replaces: the model would send something
// it did not write and never learn that it had. So the predicate must refuse on ANY doubt, and each
// refusal below is a distinct way it could have over-reached.
describe("POSITIVE — a string in a string-array slot is a one-element array", () => {
  it('the model spelling :fields "a" reaches the tool as ["a"]', async () => {
    expect(await sent(`(ct/list_studies :fields "a")`)).toEqual({ fields: ["a"] });
  });

  it("a real list of strings is unchanged", async () => {
    expect(await sent(`(ct/list_studies :fields (list "a" "b"))`)).toEqual({ fields: ["a", "b"] });
  });

  it("a number in a string-array slot is not wrapped", async () => {
    expect(await sent(`(ct/list_studies :fields 1)`)).toEqual({ fields: 1 });
  });
});

describe("NEGATIVE — nothing else is reshaped (refuse on any doubt)", () => {
  it("an ARRAY-declared param keeps its array — the slot never claimed to be a dict", async () => {
    expect(await sent(`(ct/list_studies :fields (list "a" "b"))`)).toEqual({ fields: ["a", "b"] });
  });

  it("an ARRAY-declared param given alist-SHAPED data is still an array (the contract decides, not the shape)", async () => {
    // The value looks exactly like an alist. The slot says array. The slot wins.
    expect(await sent(`(ct/list_studies :fields (list (cons 'a "1")))`)).toEqual({ fields: [["a", "1"]] });
  });

  it("an object slot given NUMERIC keys is left alone — a numeric key is not a dict key", async () => {
    expect(await sent(`(ct/list_studies :query (list (list 1 2)))`)).toEqual({ query: [[1, 2]] });
  });

  it("an object slot given a RAGGED list is left alone (not every entry is a pair)", async () => {
    expect(await sent(`(ct/list_studies :query (list (cons 'a "1") "loose"))`)).toEqual({
      query: [["a", "1"], "loose"],
    });
  });

  it("an object slot given a plain list of scalars is left alone", async () => {
    expect(await sent(`(ct/list_studies :query (list "a" "b"))`)).toEqual({ query: ["a", "b"] });
  });

  it("a scalar param is untouched", async () => {
    expect(await sent(`(ct/list_studies :pageSize 10)`)).toEqual({ pageSize: 10 });
  });
});
