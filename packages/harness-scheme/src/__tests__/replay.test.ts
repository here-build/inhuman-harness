/**
 * A fan mints the call after a wait in whichever element finished first.
 * The track is claimed at the start, so replay gives each element its own child.
 */
import { EvalTrace } from "@here.build/arrival/provenance";
import { traceToRegions } from "@here.build/arrival-provenance";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  KernelPlexus,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { KernelToolCatalog, type CatalogEntry } from "@inhuman.tools/turn/catalog";
import { describe, expect, it, onTestFinished } from "vitest";

import { interpretSchemeRepl, type SchemeReplHost } from "../index.js";
import { replayScheme } from "../replay.js";

const EXPR = `(map (lambda (p)
        (let ((body (read_file p)))
          (read_file "same")))
      '("a" "b"))`;

function entry(wireName: string): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "read",
    source: { kind: "pack", pluginName: "toolkit" },
  };
}

describe("program replay", () => {
  it("a raced fan keeps each element's second read", async () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([entry("read_file")]);
    let second = 0;
    // "a"'s first read settles only after the first "same" read has, and only
    // "b" can have issued that one. Ordering, not a wall-clock delay, so a loaded
    // runner cannot let "a" get ahead.
    let firstSameSettled!: () => void;
    const bReachedSame = new Promise<void>((resolve) => {
      firstSameSettled = resolve;
    });
    const host: SchemeReplHost = {
      catalog,
      root: "/tmp/scheme-replay",
      doors: new DoorSession(() => {}),
      admit(call) {
        const args = JSON.parse(call.function.arguments) as { path?: string };
        const job = new SystemToolJob({
          name: call.function.name,
          toolCallId: call.id,
          argsJson: call.function.arguments,
        });
        const settle = () => {
          const value = args.path === "same" ? String(++second) : args.path;
          job.outcomeSnap = { ok: true, value };
          job.markComplete();
          if (args.path === "same") firstSameSettled();
        };
        if (args.path === "a") void bReachedSame.then(settle);
        else setTimeout(settle, 0);
        return job;
      },
    };
    const kernel = KernelPlexus.bootstrap();
    const session = SessionPlexus.create("scheme-replay", "/tmp/scheme-replay");
    onTestFinished(() => {
      session.destroy();
      kernel.destroy();
    });
    const program = new ProgrammaticJob({
      toolCallId: "fan",
      argsJson: JSON.stringify({ description: "test", expr: EXPR }),
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`replay`,
      queue: [program],
    });
    turn.pushChild(program);
    session.root.head = turn;
    await interpretSchemeRepl(program, host);
    const live = JSON.parse(program.receiptJson ?? "null") as { ok: boolean; value?: unknown[] };
    expect(live.ok).toBe(true);
    // b finishes first, so its second read is "1" and a's is "2". The list stays in element order.
    const printed = live.value?.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ");
    expect(printed).toContain("2");
    expect(printed).toContain("1");
    expect(printed?.indexOf("2")).toBeLessThan(printed?.indexOf("1") ?? -1);

    const same = program.toolCalls.filter((call) => call.argString("path") === "same");
    expect(same.map((call) => call.track)).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(same.map((call) => call.track)).size).toBe(2);

    const trace = new EvalTrace();
    trace.withAutoBindings();
    await replayScheme(program, trace, new AbortController().signal);
    const leaves = traceToRegions(trace).roots.flatMap(function walk(node: {
      readonly kind: string;
      readonly meta?: unknown;
      readonly iterations?: readonly unknown[];
    }): { readonly meta?: unknown }[] {
      if (node.kind === "leaf") return [node];
      if (node.kind !== "fanout" || node.iterations == null) return [];
      return node.iterations.flatMap((iteration) =>
        Array.isArray(iteration) ? iteration.flatMap((child) => walk(child as typeof node)) : [],
      );
    });
    const linked = leaves.flatMap((leaf) => {
      const meta = leaf.meta;
      if (meta == null || typeof meta !== "object") return [];
      const jobId = "jobId" in meta && typeof meta.jobId === "string" ? meta.jobId : undefined;
      const args = "args" in meta && meta.args != null && typeof meta.args === "object" ? meta.args : undefined;
      const path = args != null && "path" in args && typeof args.path === "string" ? args.path : undefined;
      if (jobId === undefined) return [];
      const job = program.toolCalls.find((call) => call.uuid === jobId);
      return [{ card: path, job: job?.argString("path"), value: job?.observationPayload() }];
    });
    expect(linked).toEqual([
      { card: "a", job: "a", value: "a" },
      { card: "same", job: "same", value: "2" },
      { card: "b", job: "b", value: "b" },
      { card: "same", job: "same", value: "1" },
    ]);
  });
});
