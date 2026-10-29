/**
 * `context_recall {ref}` — read a sealed result back from the graph, paged.
 *
 * It re-exposes only what the model already saw in this session, so it needs
 * no policy floor beyond read-only. Refs resolve against turns reachable from
 * the live head (`turnTail` chain); an abandoned branch or another session
 * cannot be read.
 */
import { ProgrammaticJob, reactChunks, SessionRoot, SessionTurn, ToolCallJob } from "@inhuman.tools/harness-model";
import type { ToolOutcomeSnap } from "@inhuman.tools/harness-model/schemas";

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
  for (const turn of reachableTurns(root)) {
    for (const cell of reactChunks(turn)) {
      if (cell instanceof ToolCallJob) out.push(cell);
      else if (cell instanceof ProgrammaticJob) {
        out.push(cell, ...cell.toolCalls);
      }
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

export function recallContext(
  root: SessionRoot,
  args: { readonly ref?: unknown; readonly offset?: unknown; readonly length?: unknown },
): ToolOutcomeSnap {
  const refused = (text: string): ToolOutcomeSnap => ({ ok: false, text: `context_recall: ${text}` });
  let ref = typeof args.ref === "string" ? args.ref.trim() : "";
  if (ref === "") return refused("ref is required (job:<id> or visual:<id>)");
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
  const length =
    typeof args.length === "number" && args.length > 0
      ? Math.min(Math.floor(args.length), SQUEEZE_COMPACT_CHARS)
      : SQUEEZE_COMPACT_CHARS;

  if (ref.startsWith("visual:")) {
    const id = ref.slice("visual:".length);
    for (const turn of reachableTurns(root)) {
      const visual = turn.visuals.find((v) => v.id === id);
      if (visual === undefined) continue;
      return {
        ok: true,
        value: `[recall ${ref}] [Image attached: ${visual.mime}, ${visual.width}x${visual.height}${visual.sourcePath ? `, ${visual.sourcePath}` : ""}]`,
        json: { visualId: visual.id },
      };
    }
    return refused(`unknown or unreachable ref ${ref}`);
  }

  for (let hop = 0; hop < 4; hop += 1) {
    if (!ref.startsWith("job:")) return refused(`unknown ref ${ref} (use job:<id> or visual:<id>)`);
    const wantArgs = ref.endsWith("#args");
    const prefix = ref.slice("job:".length).replace(/#args$/, "");
    if (prefix.length < MIN_PREFIX) return refused(`ref ${ref} is too short`);
    const hits = reachableJobs(root).filter((job) => job.uuid.startsWith(prefix));
    if (hits.length === 0) return refused(`unknown or unreachable ref ${ref}`);
    if (hits.length > 1) return refused(`ref ${ref} is ambiguous`);
    const job = hits[0]!;
    if (nameOf(job) === CONTEXT_RECALL_TOOL_NAME) {
      // A recall of a recall resolves to the original.
      const inner = job.args?.ref;
      if (typeof inner !== "string") return refused(`ref ${ref} names an unreadable recall`);
      ref = inner;
      if (ref.startsWith("visual:")) return recallContext(root, { ref, offset, length });
      continue;
    }
    if (!wantArgs && !job.completed) return refused(`${ref} has no sealed result yet`);
    const text = wantArgs ? JSON.stringify(job.args ?? {}) : sealedJobText(job);
    const total = text.length;
    const pages = Math.max(1, Math.ceil(total / length));
    const end = Math.min(total, offset + length);
    const note =
      !wantArgs && job instanceof ToolCallJob && job.regenerateable ? "; as observed, re-read for current" : "";
    const header = `[recall ${ref} ${nameOf(job)}${wantArgs ? " args" : ""}: chars ${offset}-${end} of ${total}, page ${Math.floor(offset / length) + 1}/${pages}${end < total ? `; next offset ${end}` : ""}${note}]`;
    return { ok: true, value: `${header}\n${text.slice(offset, end)}` };
  }
  return refused("ref chain too deep");
}
