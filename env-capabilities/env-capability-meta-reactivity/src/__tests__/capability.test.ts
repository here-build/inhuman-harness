import { EnvCapability, exec, jsToScheme, toJS, type SchemeValue } from "@here.build/arrival";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type AccessKeyOf } from "../access-key.js";
import { baselineOf, metaReactivityCapability } from "../capability.js";

const mcpRows = EnvCapability.define("mcp", {
  configuration: {
    rows: z.array(z.unknown()),
  },
  symbols: (symbol, sz) => ({
    "mcp/rows": symbol.native`mcp/rows: borrowed JS array of comment rows`(
      { input: [], output: [sz.schemeValue] },
      function () {
        return jsToScheme(this.runCtx, this.configuration.rows);
      },
    ),
  }),
});

async function tick(job: object, src: string, keyOf?: AccessKeyOf, rows?: unknown[]): Promise<unknown> {
  metaReactivityCapability.begin(job);
  const results = await exec(src, {
    capabilities: rows === undefined ? [metaReactivityCapability] : [metaReactivityCapability, mcpRows],
    config: { job, keyOf: keyOf ?? (() => "comments"), rows },
  });
  return results.at(-1);
}

function watchKeyOf(list: SchemeValue): string | undefined {
  const js = toJS(list);
  if (!Array.isArray(js) || js.length === 0) return undefined;
  const head = js[0];
  if (head !== null && typeof head === "object" && "watch" in head) {
    const watch = (head as { watch: unknown }).watch;
    return typeof watch === "string" ? watch : undefined;
  }
  return undefined;
}

const report = (list: string) => `
  (let ((xs ${list}))
    (list
      (map :id (meta-reactivity/added xs :identity :id))
      (map :id (meta-reactivity/removed xs :identity :id))
      (map (lambda (p) (list (:body (car p)) (:body (cadr p))))
           (meta-reactivity/changed xs :identity :id))))
`;

describe("metaReactivityCapability", () => {
  it("first snapshot is empty, then add/remove/change; abandon and commitKeys hold the baseline", async () => {
    const job = {};
    const empty = await tick(job, report(`(list (dict :id 1 :body "a") (dict :id 2 :body "b"))`));
    metaReactivityCapability.commit(job);
    const edited = await tick(job, report(`(list (dict :id 2 :body "B") (dict :id 3 :body "c"))`));
    metaReactivityCapability.commit(job);
    await tick(
      job,
      `(begin
         (meta-reactivity/done-condition #f "no")
         (meta-reactivity/done-condition (or #f #t) "merged")
         (meta-reactivity/added (list (dict :id 2 :body "B") (dict :id 3 :body "c") (dict :id 4 :body "d")) :identity :id))`,
    );
    const held = baselineOf(job);
    const doneFace = {
      requested: held.doneRequested,
      result: held.doneResult === undefined ? null : toJS(held.doneResult),
    };
    metaReactivityCapability.abandon(job);
    const afterAbandon = await tick(
      job,
      report(`(list (dict :id 2 :body "B") (dict :id 3 :body "c") (dict :id 4 :body "d"))`),
    );
    metaReactivityCapability.commit(job);

    const two = {};
    await tick(
      two,
      `(list
         (meta-reactivity/added :identity :id (list (dict :watch "comments" :id 1)))
         (meta-reactivity/added :identity :id (list (dict :watch "reviewers" :id 1))))`,
      watchKeyOf,
    );
    metaReactivityCapability.commit(two);
    await tick(
      two,
      `(list
         (meta-reactivity/added :identity :id (list (dict :watch "comments" :id 1) (dict :watch "comments" :id 2)))
         (meta-reactivity/added :identity :id (list (dict :watch "reviewers" :id 1) (dict :watch "reviewers" :id 9))))`,
      watchKeyOf,
    );
    baselineOf(two).commitKeys(["comments"]);
    const partial = await tick(
      two,
      `(list
         (map :id (meta-reactivity/added :identity :id (list (dict :watch "comments" :id 1) (dict :watch "comments" :id 2))))
         (map :id (meta-reactivity/added :identity :id (list (dict :watch "reviewers" :id 1) (dict :watch "reviewers" :id 9)))))`,
      watchKeyOf,
    );

    const borrowed = {};
    const borrowedReport = `
      (list
        (map :id (meta-reactivity/added (mcp/rows) :identity :id))
        (map :id (meta-reactivity/removed (mcp/rows) :identity :id))
        (map (lambda (p) (list (:body (car p)) (:body (cadr p))))
             (meta-reactivity/changed (mcp/rows) :identity :id)))`;
    const borrowedEmpty = await tick(borrowed, borrowedReport, undefined, [
      { id: 1, body: "a" },
      { id: 2, body: "b" },
    ]);
    metaReactivityCapability.commit(borrowed);
    const borrowedEdited = await tick(borrowed, borrowedReport, undefined, [
      { id: 2, body: "B" },
      { id: 3, body: "c" },
    ]);

    expect({ empty, edited, afterAbandon, partial, borrowedEmpty, borrowedEdited, doneFace }).toEqual({
      empty: [[], [], []],
      edited: [[3], [1], [["B", "b"]]],
      afterAbandon: [[4], [], []],
      partial: [[], [9]],
      borrowedEmpty: [[], [], []],
      borrowedEdited: [[3], [1], [["B", "b"]]],
      doneFace: { requested: true, result: "merged" },
    });
  });

  it("treats :id reorder as stable, position swap as changed, and an id field change as remove+add", async () => {
    const job = {};
    await tick(job, `(meta-reactivity/added :identity :id (list (dict :id 1 :body "a") (dict :id 2 :body "b")))`);
    metaReactivityCapability.commit(job);
    const views = await tick(
      job,
      `(let ((xs (list (dict :id 2 :body "b") (dict :id 1 :body "a"))))
         (list
           (map :id (meta-reactivity/added :identity :id xs))
           (map :id (meta-reactivity/added xs :identity :id))
           (map :id (meta-reactivity/added :identity (lambda (c) (:id c)) xs))
           (length (meta-reactivity/changed :identity :id xs))
           (length (meta-reactivity/changed xs))))`,
    );
    metaReactivityCapability.commit(job);
    const idSwap = await tick(job, report(`(list (dict :id 10 :body "a") (dict :id 2 :body "b"))`));
    expect({ views, idSwap }).toEqual({
      views: [[], [], [], 0, 2],
      idSwap: [[10], [1], []],
    });
  });

  it("doors duplicate identity, a missing access key, and a non-list", async () => {
    const job = {};
    await expect(tick(job, `(meta-reactivity/added :identity :id (list (dict :id 1) (dict :id 1)))`)).rejects.toThrow(
      /duplicate identity/,
    );
    await expect(
      exec(`(meta-reactivity/added (list 1))`, {
        capabilities: [metaReactivityCapability],
        config: { job: {} },
      }),
    ).rejects.toThrow(/path-stable access key/);
    await expect(tick(job, `(meta-reactivity/added (dict :id 1))`)).rejects.toThrow(/proper list/);
  });
});
