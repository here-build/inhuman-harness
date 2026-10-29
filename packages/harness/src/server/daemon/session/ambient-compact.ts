/**
 * Ambient compact is a parallel isolated completion, not a tail splice.
 * The turn does not wait.
 *
 * Who reads the summary: nothing in the product. `runCompactJob` and the
 * compaction program build their own card from the full prefix and never
 * consult it; the only thing read back is `ambientCompactKey` on the cutoff
 * round, which stops the same prefix from starting a second summarizer. The
 * summary is kept as the isolated completion's `responseText` so that a reader
 * (a future cheap-cutoff path) has something to find. Until one exists the run
 * is deliberately minimal: it holds the prefix text only while the request is
 * in flight, then keeps the result and a reference, and completes.
 */
import { fail } from "@inhuman.tools/harness-diagnostics";
import { CompletionExpectation, CompletionJob, PromptMessage, type SessionTurn } from "@inhuman.tools/harness-model";
import type { CompleteRequest, CompleteResult } from "@inhuman.tools/harness-provider-sdk";

import { textOfCell, Transcript } from "@/context";

import { promptMessageOf } from "./prompt-message-of.js";

const SNAPSHOT_SYSTEM = `Fold this conversation prefix into a reference snapshot. Keep decisions, constraints, errors, and unresolved work. Drop tool chatter the snapshot does not need. Do not address the reader. Do not list next steps.`;

function kvTrim(kvs: Readonly<Record<string, string>>, key: string): string {
  if (!Object.hasOwn(kvs, key)) return "";
  return kvs[key].trim();
}

export function ambientModel(kvs: Readonly<Record<string, string>>, fallback: string): string {
  const named = kvTrim(kvs, "models.summarizer") || kvTrim(kvs, ":models.summarizer");
  return named !== "" ? named : fallback.trim();
}

/** First kept round. The summary of everything older hangs here. */
export function ambientCutoff(keep: Transcript): CompletionJob | null {
  for (const cell of keep.cells) {
    if (cell instanceof CompletionJob) return cell;
    if (cell instanceof CompletionExpectation && cell.parent instanceof CompletionJob) return cell.parent;
  }
  return null;
}

export function ambientKey(prefix: Transcript, focus: string): string {
  const head = textOfCell(prefix.cells[0]).slice(0, 80);
  const tail = textOfCell(prefix.cells.at(-1)).slice(0, 80);
  return `${prefix.cells.length}\0${prefix.tokensUsed()}\0${head}\0${tail}\0${focus}`;
}

/**
 * Fire a summarizer beside the turn. Returns the settlement promise so a test
 * can observe it; the turn loop must not await it.
 */
export function startAmbientCompact(opts: {
  readonly home: SessionTurn;
  readonly cutoff: CompletionJob;
  readonly prefix: Transcript;
  readonly focus: string;
  readonly connectionId: string;
  readonly model: string;
  readonly complete: (req: CompleteRequest) => Promise<CompleteResult>;
  readonly inflight: Map<CompletionJob, string>;
}): Promise<void> {
  const key = ambientKey(opts.prefix, opts.focus);
  if (opts.cutoff.ambientCompactKey === key) return Promise.resolve();
  if (opts.inflight.get(opts.cutoff) === key) return Promise.resolve();
  const transcript = opts.prefix.cells
    .map((cell) => textOfCell(cell))
    .filter((line) => line !== "")
    .join("\n\n");
  if (transcript === "" || opts.connectionId === "" || opts.model === "") return Promise.resolve();
  opts.inflight.set(opts.cutoff, key);
  return runAmbientCompact(opts, key, transcript);
}

async function runAmbientCompact(
  opts: {
    readonly home: SessionTurn;
    readonly cutoff: CompletionJob;
    readonly focus: string;
    readonly connectionId: string;
    readonly model: string;
    readonly complete: (req: CompleteRequest) => Promise<CompleteResult>;
    readonly inflight: Map<CompletionJob, string>;
  },
  key: string,
  transcript: string,
): Promise<void> {
  const user = opts.focus === "" ? transcript : `${transcript}\n\nEmphasize:\n${opts.focus}`;
  let job: CompletionJob | null = null;
  try {
    const round = new CompletionExpectation({
      connectionId: opts.connectionId,
      model: opts.model,
      completionMode: "isolated",
      reasoningEffort: "none",
      // The transcript prefix is the whole conversation again: past the inline limit it lives in the blob
      // bucket and the document keeps its head.
      promptMessages: [promptMessageOf("system", SNAPSHOT_SYSTEM), promptMessageOf("user", user)],
    });
    job = new CompletionJob({ expectation: round });
    opts.home.pushChild(job);
    await opts.complete({
      connectionId: opts.connectionId,
      model: opts.model,
      promptText: round.userPrompt,
      round,
    });
    if (opts.inflight.get(opts.cutoff) !== key) return;
    const text = round.responseText.trim();
    if (round.outcome !== "successful" || text === "") return;
    // The summary stays on the isolated completion (the result). The key is what
    // stops the next round with this prefix from starting another summarizer.
    opts.cutoff.ambientCompactKey = key;
  } catch (error) {
    if (opts.inflight.get(opts.cutoff) === key) fail("ambient compact", error);
  } finally {
    if (job != null) settleAmbientJob(job, key, opts.focus);
    if (opts.inflight.get(opts.cutoff) === key) opts.inflight.delete(opts.cutoff);
  }
}

/**
 * A settled ambient run keeps its result and a reference to what it summarized,
 * not the copy of the prefix it was asked about: that copy is the whole
 * conversation again and nothing reads it. The job is then complete, however
 * the run ended (a newer prefix winning counts), so it is not left open.
 */
function settleAmbientJob(job: CompletionJob, key: string, focus: string): void {
  const round = job.expectation;
  if (!round.isDone) return;
  const [cells = "?", tokens = "?"] = key.split("\0");
  const ref = [`ambient compact of a prefix of ${cells} cells, ${tokens} tokens`];
  if (focus !== "") ref.push(`focus: ${focus}`);
  round.promptMessages = [new PromptMessage({ role: "user", content: ref.join("\n") })];
  if (!job.completed) job.markComplete();
}
