/**
 * The synthetic world for workflow stories and the fold gate: a fake capability
 * that stands where the daemon's scheme verbs stand, a clock that holds calls
 * open on demand, and a corpus of programs the graph has to read.
 *
 * Nothing here imitates the daemon's timing. A call settles at once unless its
 * script step holds it, and only a test or a story releases it.
 */
import { EnvCapability, exec, isSchemeValue, toJS, type CallCtx, type SchemeValue } from "@here.build/arrival";
import { EvalTrace, type RegionGraph, TraceRegionFold } from "@here.build/arrival-provenance";
import type { ToolCallJob } from "@inhuman.tools/harness-model";
import { diffJson, type WorkflowFrame, type WorkflowLeafMeta } from "@inhuman.tools/harness-model/session";
import { keywordsOf } from "@inhuman.tools/harness-scheme/keywords";
import { observable, reaction, runInAction, type ObservableMap } from "mobx";

import type { WorkflowCell } from "../workflow/cell.js";
import { type Feed, foldFrame } from "../workflow/feed.js";
import { indexRegions } from "../workflow/region-nesting.js";

/* Clock: holds, by key, backed by deferreds. */

type Gate = { readonly open: Promise<void>; readonly release: () => void };

const gate = (): Gate => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return { open, release };
};

/** Deterministic holds: a call parks on a key until released; a test awaits that it parked. */
export class WorkflowClock {
  readonly #gates = new Map<string, Gate>();
  readonly #parked = new Map<string, Gate>();

  #gate(key: string): Gate {
    let found = this.#gates.get(key);
    if (found === undefined) this.#gates.set(key, (found = gate()));
    return found;
  }

  #arrival(key: string): Gate {
    let found = this.#parked.get(key);
    if (found === undefined) this.#parked.set(key, (found = gate()));
    return found;
  }

  /** Park the caller on `key` until `release(key)`. A key released first does not park. */
  hold(key: string): Promise<void> {
    this.#arrival(key).release();
    return this.#gate(key).open;
  }

  release(key: string): void {
    this.#gate(key).release();
  }

  releaseAll(): void {
    for (const held of this.#gates.values()) held.release();
  }

  /** Resolves once a call is parked on `key`. */
  held(key: string): Promise<void> {
    return this.#arrival(key).open;
  }
}

/* Script: what each call does. */

export type Call = {
  readonly verb: string;
  /** The worker spec, the bot, or the tool's wire name. */
  readonly name: string;
  /** The message for agents and bots, the argument record for tools. */
  readonly input: unknown;
};

export type Step = {
  /** Park on this clock key before settling. */
  readonly hold?: string;
  /** Throw this message. */
  readonly fail?: string;
  /** Throw, and leave the cell cancelled rather than failed. */
  readonly cancel?: true;
  /** While parked, show the cell as asking, with this status. */
  readonly asking?: string;
  readonly background?: true;
  /** A one-line status for the cell while it is out. */
  readonly status?: string;
  readonly value: unknown;
};

export type WorkflowScript = (call: Call) => Step;

export type WorkflowCells = ObservableMap<number, WorkflowCell>;

/* Capability: the verbs, with the real env's contracts. */

const text = (value: unknown): string => (typeof value === "string" ? value : String(value));

/** Keyword tails arrive as a record when the contract declares a record `inputRest`. */
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? { ...(value as Record<string, unknown>) } : {};

/** Arguments arrive as scheme boxes (`412` as an exact number); a card shows what the program wrote. */
const plain = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "provenance" in value ? toJS(value as SchemeValue) : value;

const MODEL = "gpt-6.1-sol";

/** The scripted stand-in for `harness/scheme-repl` plus a pack with two tools. */
export function fakeWorkflowCapability(script: WorkflowScript, clock: WorkflowClock, cells: WorkflowCells) {
  /** One crossing: mark the point first so a running call is already a leaf, then play its step. */
  async function cross<T>(ctx: Pick<CallCtx, "invocation">, meta: WorkflowLeafMeta, input: unknown): Promise<T> {
    const inv = ctx.invocation.currentInvocation;
    inv?.markProvenancePoint?.();
    if (meta.args !== undefined)
      meta = { ...meta, args: Object.fromEntries(Object.entries(meta.args).map(([key, arg]) => [key, plain(arg)])) };
    inv?.setMetadata?.(meta);
    const step = script({ verb: meta.verb, name: meta.name, input });
    const set = (cell: WorkflowCell) => {
      if (inv !== undefined) runInAction(() => cells.set(inv.id, cell));
    };
    const background = step.background === true || meta.background === true;
    if (background) inv?.setMetadata?.({ ...meta, background: true });
    set({ state: "live", status: step.status });
    if (step.hold !== undefined) {
      if (step.asking !== undefined) set({ state: "asking", status: step.asking });
      await clock.hold(step.hold);
      set({ state: "live", status: step.status });
    }
    if (step.cancel === true) {
      set({ state: "cancelled" });
      throw new Error(step.fail ?? `${meta.verb}: cancelled`);
    }
    if (step.fail !== undefined) {
      set({ state: "failed", value: step.fail });
      throw new Error(step.fail);
    }
    set({ state: "ok", value: step.value });
    return step.value as T;
  }

  const agent = (verb: "agent/call" | "agent/ask" | "bot/send" | "bot/ask", kind: "agent" | "bot") =>
    function (this: Pick<CallCtx, "invocation">, spec: unknown, message: unknown, ...rest: unknown[]) {
      const model = rest.find((_, at) => String(rest[at - 1]) === ":model");
      return cross<string>(
        this,
        {
          kind,
          verb,
          name: text(spec),
          model: model === undefined ? MODEL : text(model),
          message: text(message),
        },
        text(message),
      );
    };

  return EnvCapability.define("story/workflow", {
    symbols: (symbol, sz) => {
      const jsonDict = sz.dictRecord(sz.foldName, sz.dynamic).optional();
      const pack = (name: string) =>
        symbol.rosetta`${name}: pack tool`(
          { input: [jsonDict], output: [sz.dynamic], provenance: "source" },
          function (args?: Record<string, unknown>) {
            const input = record(args);
            return cross(this, { kind: "tool", verb: name, name, args: input }, input);
          },
        );
      return {
        "agent/call": symbol.rosetta`agent/call: a disposable worker, waited on`(
          { input: [sz.dynamic, sz.string], inputRest: sz.dynamic, output: [sz.string], provenance: "source" },
          agent("agent/call", "agent"),
        ),
        "agent/ask": symbol.rosetta`agent/ask: a disposable worker, its response required`(
          { input: [sz.dynamic, sz.string], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
          agent("agent/ask", "agent"),
        ),
        "bot/send": symbol.rosetta`bot/send: a standing bot, waited on`(
          { input: [sz.foldName, sz.string], output: [sz.string], provenance: "source" },
          agent("bot/send", "bot"),
        ),
        "bot/ask": symbol.rosetta`bot/ask: a standing bot, its response required`(
          { input: [sz.dynamic, sz.string], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
          agent("bot/ask", "bot"),
        ),
        "mcp/call": symbol.rosetta`mcp/call: a live MCP tool; connection and tool are data`(
          { input: [sz.foldName, sz.foldName], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
          function (connection: string, tool: string, ...rest: unknown[]) {
            const args: Record<string, unknown> = {};
            for (let at = 0; at + 1 < rest.length; at += 2) args[String(rest[at]).replace(/^:/, "")] = rest[at + 1];
            return cross(this, { kind: "tool", verb: "mcp/call", name: `${connection}__${tool}`, args }, args);
          },
        ),
        read_file: symbol.rosetta`read_file: a UTF-8 text file`(
          {
            input: [sz.string],
            inputRest: sz.dynamic,
            output: [sz.string],
            provenance: "source",
          },
          function (path, ...rest: unknown[]) {
            const kwargs = keywordsOf("read_file", rest, {
              offset: sz.integer.optional(),
              limit: sz.integer.optional(),
            });
            const args = { path, ...kwargs };
            return cross<string>(this, { kind: "tool", verb: "read_file", name: "read_file", args }, args);
          },
        ),
        grep: symbol.rosetta`grep: search file contents`(
          {
            input: [sz.string],
            inputRest: sz.dynamic,
            output: [sz.list(sz.string)],
            provenance: "source",
          },
          function (pattern, ...rest: unknown[]) {
            const kwargs = keywordsOf("grep", rest, {
              path: sz.string.optional(),
              glob: sz.string.optional(),
              limit: sz.integer.optional(),
            });
            const args = { pattern, ...kwargs };
            return cross<string[]>(this, { kind: "tool", verb: "grep", name: "grep", args }, args);
          },
        ),
        shell: symbol.rosetta`shell: run a command`(
          {
            input: [sz.string],
            inputRest: sz.dynamic,
            output: [sz.box],
            provenance: "source",
          },
          function (command, ...rest: unknown[]) {
            const kwargs = keywordsOf("shell", rest, {
              cwd: sz.string.optional(),
              timeoutMs: sz.integer.optional(),
            });
            const args = { command, ...kwargs };
            return cross<object>(this, { kind: "tool", verb: "shell", name: "shell", args }, args);
          },
        ),
        lint_project: pack("lint_project"),
        deploy_preview: pack("deploy_preview"),
      };
    },
  });
}

/* Run: a program to completion, or to where the clock holds it. */

export type WorkflowRun = {
  readonly trace: EvalTrace;
  readonly cells: WorkflowCells;
  /** Settles with the program's value, or with its error; never rejects. */
  readonly done: Promise<unknown>;
};

export function runWorkflow(program: string, script: WorkflowScript, clock = new WorkflowClock()): WorkflowRun {
  const trace = new EvalTrace();
  trace.withAutoBindings();
  const cells: WorkflowCells = observable.map<number, WorkflowCell>();
  const done = exec(program, { tap: trace, capabilities: [fakeWorkflowCapability(script, clock, cells)] }).then(
    (value) => value,
    (error: unknown) => error,
  );
  return { trace, cells, done };
}

/* Feed: what the daemon serves a subscriber, from a run the story holds. */

/** The graph as the daemon puts it on the wire: plain JSON, and each leaf pointing at its job, valueless. Leaf `n` is job `n`. */
function wire(graph: RegionGraph, jobs: readonly ToolCallJob[]): RegionGraph {
  const jobIds = new Map<number, string>();
  let at = 0;
  for (const region of indexRegions(graph.roots).values()) {
    if (region.kind !== "leaf") continue;
    const job = jobs.at(at++);
    if (job !== undefined) jobIds.set(region.id, job.uuid);
  }
  return JSON.parse(
    JSON.stringify(graph, function (this: Record<string, unknown>, key: string, value: unknown) {
      const jobId = this.kind === "leaf" ? jobIds.get(this.id as number) : undefined;
      if (jobId !== undefined && key === "value") return undefined;
      if (jobId !== undefined && key === "meta") return { ...(value as object), jobId };
      return isSchemeValue(value) ? toJS(value as SchemeValue) : value;
    }),
  ) as RegionGraph;
}

/**
 * The daemon's side of a subscription, run on a story's trace: fold it as it grows, diff each fold
 * into frames, close with a `done` one. The client's own fold reads the frames.
 */
export function serveWorkflow(
  run: WorkflowRun,
  jobs: () => readonly ToolCallJob[],
  onGraph: (graph: RegionGraph, done: boolean) => void,
  signal: AbortSignal,
): void {
  const fold = new TraceRegionFold(run.trace);
  let sent: unknown;
  let seq = 0;
  let feed: Feed | null = null;
  const flush = (done: boolean): void => {
    fold.applyDelta();
    const next = wire(fold.current(), jobs());
    const frame: WorkflowFrame =
      feed === null
        ? { kind: "snapshot", gen: 1, seq: ++seq, graph: next, done }
        : { kind: "patch", gen: 1, seq: ++seq, ops: diffJson(sent, next), done };
    if (frame.kind === "patch" && frame.ops.length === 0 && !done) {
      seq -= 1;
      return;
    }
    sent = next;
    const folded = foldFrame(feed, frame);
    if (folded === "resync") throw new Error("the story feed fell out of step");
    feed = folded;
    onGraph(folded.graph, folded.done);
  };
  const stop = reaction(
    () => run.trace.entries,
    () => flush(false),
    { fireImmediately: true },
  );
  signal.addEventListener("abort", stop, { once: true });
  void (async () => {
    await run.done;
    if (signal.aborted) return;
    flush(true);
    stop();
  })();
}

/* Corpus: realistic harness programs, each with the script that makes its graph worth reading. */

export type WorkflowProgram = {
  readonly source: string;
  /** A fresh script per run: scripts count calls, so they carry state. */
  readonly script: () => WorkflowScript;
};

const say = (value: unknown): Step => ({ value });

const FILES = { api: "src/api.ts", ui: "src/ui.tsx", db: "src/db.ts", legacy: "src/legacy.ts" } as const;

export const WORKFLOWS = {
  /** Explore three areas in parallel, have a reviewer read the findings, then act on the verdict. */
  fanout: {
    source: `(define findings (map (lambda (area) (agent/call "explore" (string-append "look at " area))) (list "api" "ui" "db")))
(define review (agent/ask "reviewer" (apply string-append findings)))
(if (> (string-length review) 3) (agent/call "implementer" review) "skip")`,
    script: () => (call) => {
      if (call.name === "explore") return say(`${text(call.input).slice(8)} has two seams worth splitting. `);
      if (call.name === "reviewer") return say("Split the api seam first; ui and db follow.");
      return say("Implemented the api split behind a flag.");
    },
  },

  /** Draft, review, rewrite until the reviewer signs off or the third pass. */
  loop: {
    source: `(let loop ((draft "migration plan v0") (pass 0))
  (let ((verdict (agent/ask "reviewer" draft)))
    (if (or (>= pass 3) (string=? (substring verdict 0 4) "LGTM"))
        draft
        (loop (agent/call "writer" (string-append draft " / " verdict)) (+ pass 1)))))`,
    script: () => {
      let reviews = 0;
      return (call) => {
        if (call.name === "reviewer")
          return say(++reviews < 3 ? `needs work: pass ${reviews} skips the rollback` : "LGTM, ship it.");
        return say(`migration plan v${reviews}`);
      };
    },
  },

  /** Audit files for TODOs and send a fixer only where there are some. Both arms happen. */
  branch: {
    source: `(map (lambda (f)
  (let ((hits (grep "TODO" :path f)))
    (if (null? hits)
        "clean"
        (agent/call "fixer" f))))
  (list "${FILES.api}" "${FILES.ui}" "${FILES.db}"))`,
    script: () => (call) => {
      if (call.name === "grep") {
        const { path } = call.input as { path: string };
        return say(path === FILES.ui ? [] : [`${path}:12: TODO tighten this`]);
      }
      return say(`fixed ${text(call.input)}`);
    },
  },

  /** Read every file, keep the ones with content, port each survivor. */
  filter: {
    source: `(define contents (map (lambda (f) (read_file f)) (list "${FILES.api}" "${FILES.ui}" "${FILES.legacy}")))
(map (lambda (src) (agent/call "porter" src))
  (filter (lambda (s) (> (string-length s) 0)) contents))`,
    script: () => (call) => {
      if (call.name === "read_file") {
        const { path } = call.input as { path: string };
        return say(path === FILES.legacy ? "" : `// ${path}`);
      }
      return say(`ported ${text(call.input)}`);
    },
  },

  /** A lead reads what a scout found, once per area. */
  nested: {
    source: `(define areas (list "api" "ui" "db"))
(map (lambda (a) (agent/ask "lead" (string-append a ": " (agent/call "scout" a)))) areas)`,
    script: () => (call) =>
      call.name === "scout" ? say(`${text(call.input)} has a stale cache`) : say(`plan for ${text(call.input)}`),
  },

  /** Read a PR, lint, build, and report; the build fails and the program carries on with a value. */
  tools: {
    source: `(define pr (mcp/call "github" "get_pull_request" :number 412))
(define lint (lint_project (dict :path "src")))
(define build (guard (e (#t "build failed")) (shell "pnpm build" :cwd "packages/web")))
(define notes (read_file "CHANGELOG.md"))
(string-append "PR 412: " build " / " notes)`,
    script: () => (call) => {
      if (call.verb === "mcp/call") return say({ title: "Split the api seam", state: "open" });
      if (call.verb === "lint_project") return say({ warnings: 3, errors: 0 });
      if (call.verb === "shell") return { fail: "exit 1: tsc found 2 errors", value: undefined, status: "pnpm build" };
      return say("## Unreleased\n- split api seam");
    },
  },
} as const satisfies Record<string, WorkflowProgram>;

export type WorkflowName = keyof typeof WORKFLOWS;
