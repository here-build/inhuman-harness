/**
 * `context_recall {ref}` — read a sealed result or owned worker log back from the graph, paged.
 *
 * It re-exposes only what the model already saw in this session or spawned
 * as a worker of this session, so it needs no policy floor beyond read-only.
 * Refs resolve against turns reachable from the live head (`turnTail` chain);
 * an abandoned branch or another unrelated session cannot be read.
 */
import { ProgrammaticJob, reactChunks, SessionRoot, SessionTurn, ToolCallJob } from "@inhuman.tools/harness-model";
import type { ToolOutcomeSnap } from "@inhuman.tools/harness-model/schemas";

import { renderWorkerLog, resolveOwnedWorker, workerSessionLoaderOf, type ResolvedOwnedWorker } from "./worker-log.js";
import { SQUEEZE_COMPACT_CHARS, liftToolImages, paintObservation } from "../context/squeeze.js";

export const CONTEXT_RECALL_TOOL_NAME = "context_recall";

const MIN_PREFIX = 4;

function reachableTurns(root: SessionRoot): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (let cell: unknown = root.head; cell instanceof SessionTurn && !out.includes(cell); cell = cell.turnTail) {
    out.push(cell);
  }
  return out;
}

function reachableJobs(root: SessionRoot): Array<ToolCallJob | ProgrammaticJob> {
  const out: Array<ToolCallJob | ProgrammaticJob> = [];
  const seen = new Set<ToolCallJob | ProgrammaticJob>();
  const visit = (job: ToolCallJob | ProgrammaticJob): void => {
    if (seen.has(job)) return;
    seen.add(job);
    out.push(job);
    for (const child of job.children) {
      if (child instanceof ToolCallJob || child instanceof ProgrammaticJob) visit(child);
    }
  };
  for (const turn of reachableTurns(root)) {
    for (const cell of reactChunks(turn)) {
      if (cell instanceof ToolCallJob || cell instanceof ProgrammaticJob) visit(cell);
    }
  }
  return out;
}

export function sealedJobText(job: ToolCallJob | ProgrammaticJob): string {
  if (job instanceof ToolCallJob) return paintObservation(liftToolImages(job.observationPayload()).payload);
  const text = job.resultText();
  return text !== "" ? text : (job.receiptJson ?? "");
}

function nameOf(job: ToolCallJob | ProgrammaticJob): string {
  return job instanceof ToolCallJob ? job.name : job.toolName;
}

function isWorkerLogRef(ref: string): boolean {
  return ref.startsWith("agent:") || (ref.startsWith("job:") && ref.endsWith("#log"));
}

function refusedRecall(text: string): ToolOutcomeSnap {
  return { ok: false, text: `context_recall: ${text}` };
}

function parsePageWindow(args: { readonly offset?: unknown; readonly length?: unknown }): {
  readonly offset: number;
  readonly length: number;
} {
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
  const length =
    typeof args.length === "number" && args.length > 0
      ? Math.min(Math.floor(args.length), SQUEEZE_COMPACT_CHARS)
      : SQUEEZE_COMPACT_CHARS;
  return { offset, length };
}

type RecallTarget =
  | { readonly kind: "done"; readonly outcome: ToolOutcomeSnap }
  | { readonly kind: "worker-log"; readonly resolved: Extract<ResolvedOwnedWorker, { ok: true }> };

function resolveRecallTarget(root: SessionRoot, rawRef: unknown, offset: number, length: number): RecallTarget {
  let ref = typeof rawRef === "string" ? rawRef.trim() : "";
  if (ref === "")
    return { kind: "done", outcome: refusedRecall("ref is required (job:<id>, visual:<id>, or agent:<id>)") };

  for (let hop = 0; hop < 4; hop += 1) {
    if (ref.startsWith("visual:")) {
      const id = ref.slice("visual:".length);
      for (const turn of reachableTurns(root)) {
        const visual = turn.visuals.find((v) => v.id === id);
        if (visual === undefined) continue;
        return {
          kind: "done",
          outcome: {
            ok: true,
            value: `[recall ${ref}] [Image attached: ${visual.mime}, ${visual.width}x${visual.height}${visual.sourcePath ? `, ${visual.sourcePath}` : ""}]`,
            json: { visualId: visual.id },
          },
        };
      }
      return { kind: "done", outcome: refusedRecall(`unknown or unreachable ref ${ref}`) };
    }

    if (isWorkerLogRef(ref)) {
      const resolved = resolveOwnedWorker(root, ref);
      if (!resolved.ok) return { kind: "done", outcome: refusedRecall(resolved.error) };
      return { kind: "worker-log", resolved };
    }

    if (!ref.startsWith("job:")) {
      return { kind: "done", outcome: refusedRecall(`unknown ref ${ref} (use job:<id>, visual:<id>, or agent:<id>)`) };
    }
    const wantArgs = ref.endsWith("#args");
    const prefix = ref.slice("job:".length).replace(/#args$/, "");
    if (prefix.length < MIN_PREFIX) return { kind: "done", outcome: refusedRecall(`ref ${ref} is too short`) };
    const hits = reachableJobs(root).filter((job) => job.uuid.startsWith(prefix));
    if (hits.length === 0) return { kind: "done", outcome: refusedRecall(`unknown or unreachable ref ${ref}`) };
    if (hits.length > 1) return { kind: "done", outcome: refusedRecall(`ref ${ref} is ambiguous`) };
    const job = hits[0]!;
    if (nameOf(job) === CONTEXT_RECALL_TOOL_NAME) {
      // A recall of a recall resolves to the original.
      const inner = job.args?.ref;
      if (typeof inner !== "string")
        return { kind: "done", outcome: refusedRecall(`ref ${ref} names an unreadable recall`) };
      ref = inner;
      continue;
    }
    if (!wantArgs && !job.completed) return { kind: "done", outcome: refusedRecall(`${ref} has no sealed result yet`) };
    const text = wantArgs ? JSON.stringify(job.args ?? {}) : sealedJobText(job);
    const total = text.length;
    const pages = Math.max(1, Math.ceil(total / length));
    const end = Math.min(total, offset + length);
    const note =
      !wantArgs && job instanceof ToolCallJob && job.regenerateable ? "; as observed, re-read for current" : "";
    const header = `[recall ${ref} ${nameOf(job)}${wantArgs ? " args" : ""}: chars ${offset}-${end} of ${total}, page ${Math.floor(offset / length) + 1}/${pages}${end < total ? `; next offset ${end}` : ""}${note}]`;
    return { kind: "done", outcome: { ok: true, value: `${header}\n${text.slice(offset, end)}` } };
  }
  return { kind: "done", outcome: refusedRecall("ref chain too deep") };
}

function formatWorkerLogPage(
  resolved: Extract<ResolvedOwnedWorker, { ok: true }>,
  worker: SessionRoot | undefined,
  offset: number,
  length: number,
): ToolOutcomeSnap {
  const text = renderWorkerLog(resolved, worker);
  const total = text.length;
  const pages = Math.max(1, Math.ceil(total / length));
  const end = Math.min(total, offset + length);
  const tailOffset = Math.max(0, total - length);
  const tailHint = end < total ? `; next offset ${end}; tail offset ${tailOffset}` : "";
  const header = `[recall ${resolved.canonicalRef} agent_log: chars ${offset}-${end} of ${total}, page ${Math.floor(offset / length) + 1}/${pages}${tailHint}]`;
  return { ok: true, value: `${header}\n${text.slice(offset, end)}` };
}

export function recallContext(
  root: SessionRoot,
  args: { readonly ref?: unknown; readonly offset?: unknown; readonly length?: unknown },
): ToolOutcomeSnap {
  const { offset, length } = parsePageWindow(args);
  const target = resolveRecallTarget(root, args.ref, offset, length);
  if (target.kind === "done") return target.outcome;
  const wid = target.resolved.workerSessionId;
  const worker = wid === "" ? undefined : workerSessionLoaderOf(root)?.peek(wid);
  return formatWorkerLogPage(target.resolved, worker, offset, length);
}

export async function recallContextAsync(
  root: SessionRoot,
  args: { readonly ref?: unknown; readonly offset?: unknown; readonly length?: unknown },
): Promise<ToolOutcomeSnap> {
  const { offset, length } = parsePageWindow(args);
  const target = resolveRecallTarget(root, args.ref, offset, length);
  if (target.kind === "done") return target.outcome;
  const wid = target.resolved.workerSessionId;
  const loader = wid === "" ? undefined : workerSessionLoaderOf(root);
  let worker = loader?.peek(wid);
  if (worker == null && loader != null) {
    const loaded = await loader.load(wid);
    worker = loaded?.root;
  }
  return formatWorkerLogPage(target.resolved, worker, offset, length);
}
