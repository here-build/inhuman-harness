/**
 * Job factories and waiters for remainder-PDP orchestrator tests.
 * toolCallId is always unique so two identical commands can share a turn.
 */
import { CompletionExpectation, CompletionJob, SystemToolJob } from "@inhuman.tools/harness-model";
import type { Job } from "@inhuman.tools/plexus-expectations";
import { when } from "mobx";

/** Guard only: a `when` that never fires. Sized for a loaded 4-core CI runner, below the 30s test timeout. */
export const TIMEOUT = 25_000;

let n = 0;

function nextId(kind: string, key: string): string {
  n += 1;
  return `${kind}-${n}-${key}`;
}

export function shell(command: string, cwd?: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: nextId("sh", command),
    name: "shell",
    argsJson: JSON.stringify(cwd === undefined ? { command } : { command, cwd }),
  });
}

export function write(path: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: nextId("w", path),
    name: "write_file",
    argsJson: JSON.stringify({ path }),
  });
}

export function read(path: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: nextId("r", path),
    name: "read_file",
    argsJson: JSON.stringify({ path }),
  });
}

/** Completed turn-tape completion. `responseText` is the prior-turn cut. */
export function completedAssistant(text: string): CompletionJob {
  const pew = new CompletionExpectation({ connectionId: "seed" });
  pew.succeed("settled", "", "null", { result: { text } });
  return new CompletionJob({ expectation: pew });
}

/** Sealed sibling tool. Labeled `name → text` becomes the quarantined cut. */
export function sealedObservation(labeled: string): SystemToolJob {
  const sep = " → ";
  const at = labeled.indexOf(sep);
  const name = at === -1 ? "tool" : labeled.slice(0, at);
  const text = at === -1 ? labeled : labeled.slice(at + sep.length);
  return new SystemToolJob({
    toolCallId: nextId("q", name),
    name,
    argsJson: "{}",
    outcomeJson: JSON.stringify({ ok: true, text }),
    completed: true,
  });
}

/** Judge PEWs hang on CompletionJob cells parented onto the tool job. */
export function childCompletions(job: { readonly children: readonly Job[] }): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const child of job.children) {
    if (child instanceof CompletionJob && child.expectation != null) out.push(child.expectation);
  }
  return out;
}

export async function settled(job: { orchestrated: boolean }): Promise<void> {
  await when(() => job.orchestrated, { timeout: TIMEOUT });
}

export async function failed(job: { classifierAbstain: string | null }): Promise<void> {
  await when(() => job.classifierAbstain !== null, { timeout: TIMEOUT });
}
