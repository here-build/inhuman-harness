import { describe, expect, it } from "vitest";

import { callDeclaredTool, Dict, dispatchBoundary, loadProgram, NoteLog } from "../index.js";
import { Proc, type Registry, type Val } from "../value.js";
import { modelCatalog } from "./model-catalog.js";

async function load(
  source: string,
  opts: {
    readonly agentId?: string;
    readonly environment?: ReadonlyMap<string, Proc>;
  } = {},
): Promise<Registry> {
  return loadProgram({
    agentId: opts.agentId ?? "agent",
    source,
    filename: "/pkg/behavior.scm",
    revision: "rev",
    root: "/pkg",
    read: () => {
      throw new Error("missing source");
    },
    kind: "behavior",
    environment: opts.environment,
  });
}

function recorder(): {
  readonly seen: Val[];
  readonly environment: ReadonlyMap<string, Proc>;
} {
  const seen: Val[] = [];
  const note = new Proc("note", (args) => {
    seen.push(args[0] ?? false);
    return false;
  });
  return { seen, environment: new Map([["note", note]]) };
}

describe("lifecycle boundary", () => {
  it("wraps the boundary once: pre, core, post", async () => {
    const { seen, environment } = recorder();
    const registry = await load(
      `
      (hook/round :pre (lambda (round) (begin (note "pre") (self/notify 'ambient "branch"))))
      (hook/round :post (lambda (round) (begin (note "post") (self/notify 'activating "open"))))
    `,
      { environment },
    );
    const notes = new NoteLog();
    const outcome = await dispatchBoundary({
      registry,
      point: "round",
      record: "round-1",
      notes,
      turnId: "t1",
      core: () => {
        seen.push("core");
        return "done";
      },
    });
    expect(seen).toEqual(["pre", "core", "post"]);
    expect(outcome.result).toBe("done");
    expect(notes.notes.map((note) => [note.boundary, note.message])).toEqual([
      ["round-start", "branch"],
      ["round-end", "open"],
    ]);
  });

  it("expires every unconsumed note of a sealed turn", () => {
    const notes = new NoteLog();
    for (const boundary of ["turn-start", "round-end", "turn-end"] as const) {
      notes.emit({
        agentId: "agent",
        mode: "ambient",
        boundary,
        message: boundary,
        turnId: "t1",
      });
    }
    notes.expireUnused("agent", "t1");
    expect(notes.peek("agent")).toEqual([]);
  });
});

describe("declared tools", () => {
  it("validates model input that is not a dict", async () => {
    const registry = await load(
      `(define/tool 'find :description "Find" :expose 'tool :input (s/object (s/field "q" (s/string))) :handler (lambda (input) "hit"))`,
    );
    await expect(callDeclaredTool(registry, "find", "not a dict")).rejects.toThrow(/schema/);
  });

  it("publishes the input schema, with optional fields not required", async () => {
    const registry = await load(
      `(define/tool 'find :description "Find" :expose 'tool
         :input (s/object (s/field "q" (s/string)) (s/field "limit" (s/optional (s/number))))
         :handler (lambda (input) (:q input)))`,
    );
    expect(modelCatalog(registry)[0]?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "number" } },
      required: ["q"],
      additionalProperties: false,
    });
    expect(await callDeclaredTool(registry, "find", new Dict({ q: "x" }))).toBe("x");
    await expect(callDeclaredTool(registry, "find", new Dict({ q: "x", limit: "ten" }))).rejects.toThrow(
      /expected number/,
    );
  });

  it("keeps :class and :triggers-react-loop instead of dropping them", async () => {
    const registry = await load(
      `(define/tool 'offload :description "Retain" :expose 'tool :class 'meta :triggers-react-loop #f
         :input (s/object) :handler (lambda (input) "ok"))`,
    );
    expect(modelCatalog(registry)).toEqual([
      {
        name: "offload",
        description: "Retain",
        class: "meta",
        triggersReactLoop: false,
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
    await expect(load(`(define/tool 'bad :triggers-react-loop "yes" :handler (lambda (input) "ok"))`)).rejects.toThrow(
      /triggers-react-loop/,
    );
    const side = await load(
      `(define/tool 'note :description "Note" :expose 'tool :is-side-channel #t
         :input (s/object) :handler (lambda (input) "ok"))`,
    );
    expect({
      note: side.tools.get("note")?.isSideChannel,
      offload: registry.tools.get("offload")?.isSideChannel,
    }).toEqual({ note: true, offload: false });
    await expect(load(`(define/tool 'bad :is-side-channel "yes" :handler (lambda (input) "ok"))`)).rejects.toThrow(
      /is-side-channel/,
    );
  });
});
