/**
 * Call settlement and reclaim. Worker never Plexus-writes the caller.
 * `completed` is kernel-only (respond / void / exceptional).
 *
 * Child calls reclaim their owned worker after the last callback row. Bot
 * requests release their callback without reclaiming the bot. Leftovers become
 * completed+orchestrated rejected even if approved. keepAlive true stretches
 * the same loop. Two open rows: first respond is not final.
 */
import {
  AgentCallJob,
  CallJob,
  AgentCallbackJob,
  AgentNotifyJob,
  ApprovableJob,
  ProgrammaticJob,
  tapeCompletion,
  demoteSteers,
  SessionRoot,
  SessionTurn,
  ToolCallJob,
  FailureOutcome,
  cancelUnstarted,
  type CallFailCode,
  BotCallJob,
  CompactJob,
  CompletionJob,
  ReACTChunk,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnPromptChunk,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";
import { Job, walkWork, WorkExpectation } from "@inhuman.tools/plexus-expectations";
import { runInAction } from "mobx";

import { shouldSkipTurnCancel } from "./acceptance.js";
import type { AgentRuntimeHost, CallsCatalog } from "./types.js";

function rejectLeaf(leaf: ApprovableJob, reason?: unknown): void {
  if (leaf.completed || leaf.cancelled) return;
  cancelUnstarted(leaf, reason);
  if (leaf instanceof CallJob) return;
}

/** Omitted-spec session bit, or this bag's enclosing Call. Not every open Call. */
export function schemeDeskReadonly(session: SessionRoot, enclosingCall?: CallJob | null): boolean {
  return session.agent.spec.readonly || enclosingCall?.readonly === true;
}

/**
 * Honest host cancel / timeout. Completes the Call, deletes the worker row,
 * does not fabricate a respond. First-write-wins: a later respond cannot
 * replace this receipt.
 */
export function completeCallExceptionally(
  call: CallJob,
  host: AgentRuntimeHost,
  code: CallFailCode,
  message = "",
  abort?: (job: Job) => void,
): void {
  call.settleResult(new FailureOutcome({ code, message }));
  const workerId = call.workerSessionId;
  if (workerId === "") return;
  const worker = host.scope.replica(workerId);
  if (worker == null) return;
  worker.root.removeAgentCallback(call.uuid);
  // The request owns its receipt, not the independently managed bot process.
  if (call instanceof BotCallJob) return;
  if (!(call instanceof AgentCallJob)) return;
  forceStopLoop(
    worker.root,
    abort ?? (host.scope.abortJob == null ? undefined : (leaf) => host.scope.abortJob?.(workerId, leaf)),
    undefined,
    (nested) => completeCallExceptionally(nested, host, "rejected"),
    host.catalog,
  );
}

/**
 * keepAlive false + last row: leftovers on the originating turn become
 * `cancelled` + completed with a rejected receipt. `approved` stays —
 * it is a human write. Abort the turn so ReACT cannot mint further calls.
 */
export function forceStopLoop(
  root: SessionRoot,
  abort?: (job: Job) => void,
  except?: ApprovableJob,
  cancelCall?: (call: CallJob) => void,
  catalog?: CallsCatalog,
): void {
  if (root.agent.spec.keepAlive) return;
  if (Object.keys(root.agentCallbacks).length > 0) return;
  // Originating turn for `except`. A closed origin must not stop a successor head.
  let turn: SessionTurn | null = except == null ? root.findRunningTurn() : null;
  if (except != null) {
    for (const live of root.liveTurns) {
      for (const node of walkWork(live)) {
        if (node === except) {
          turn = live;
          break;
        }
      }
      if (turn != null) break;
    }
  }
  if (turn == null) return;
  closeTurn(turn, { kind: "forced", except }, { abort, cancelCall, catalog, session: root });
}

/**
 * How a turn ends. Every ending closes what is open under the turn; the
 * cause only says how the leaves are told and what the turn records.
 *
 * - `finish`: the reducer returned. Background work outlives the turn.
 * - `cancel`: the user stopped it (`cancelRequested`). Acks with `cancelled`.
 * - `broke`: the reducer threw, or a boundary refused. `detail` lands on `turn.broke`.
 * - `rewound`: the turn left the live chain before or while it ran.
 * - `forced`: the last Call row of a worker that must not outlive it.
 */
export type TurnEnding =
  | { readonly kind: "finish" }
  | { readonly kind: "cancel" }
  | { readonly kind: "broke"; readonly detail: string }
  | { readonly kind: "rewound" }
  | { readonly kind: "forced"; readonly except?: ApprovableJob };

export type CloseTurnOptions = {
  readonly catalog?: CallsCatalog;
  /** Reclaim a Call's worker before the Call is rejected. */
  readonly releaseCall?: (call: CallJob) => void;
  /** Complete a worker Call exceptionally before it is rejected (forced ending). */
  readonly cancelCall?: (call: CallJob) => void;
  /** Abort an in-flight body or executor. */
  readonly abort?: (job: Job) => void;
  /** End an open expectation through its actor, when it has one. */
  readonly terminate?: (expectation: WorkExpectation) => void;
  /**
   * The session inbox. Passed, the close demotes the steers composed against
   * this turn, but only while the turn is on the live chain: the close of a
   * turn that is not touches nothing but itself.
   */
  readonly session?: SessionRoot;
};

/**
 * THE turn close. The executor's `finally`, a cancel that finds no executor
 * inside the turn, recovery of a cancelled turn, a forced stop and a rewound
 * away turn all end a turn here, so the same obligations close in every case:
 *
 * 1. the failure, if any, is recorded on the turn (`broke`);
 * 2. every open Job and expectation under the turn ends (a finish leaves
 *    them alone: background work outlives the turn);
 * 3. the cancel ack (`cancelled`) follows a cancel request;
 * 4. unclaimed steers composed against this turn move to the queue lane (also
 *    on cancel: Stop does not discard what the user already sent), only for a
 *    turn on the live chain;
 * 5. `reducerExited` and `markComplete` last, in the same transaction, so no
 *    observer sees a closed turn with work still open under it.
 *
 * Idempotent: a second close sweeps what is still open and leaves the rest.
 */
export function closeTurn(turn: SessionTurn, ending: TurnEnding, options: CloseTurnOptions = {}): void {
  runInAction(() => {
    const first = !turn.reducerExited;
    if (ending.kind === "broke" && turn.broke === "")
      turn.broke = ending.detail === "" ? "turn stopped" : ending.detail;
    // A normal finish leaves what is open (background jobs, their attempts) to outlive the turn.
    for (const node of ending.kind === "finish" ? [] : walkWork(turn)) {
      if (node instanceof WorkExpectation) {
        if (!node.isDone) endExpectation(node, options);
        continue;
      }
      if (!(node instanceof Job) || node.completed) continue;
      if (ending.kind === "forced") {
        if (node === ending.except) continue;
        endForced(node, options);
      } else {
        endCancelled(node, options);
      }
    }
    const cancelled = ending.kind === "cancel" || turn.cancelRequested;
    if (cancelled) turn.cancelled = true;
    const session = options.session;
    if (first && session != null && session.liveChain.includes(turn)) demoteSteers(session, turn.uuid);
    turn.reducerExited = true;
    turn.markComplete();
    if (ending.kind === "forced" && first) options.abort?.(turn);
  });
}

function endExpectation(expectation: WorkExpectation, options: CloseTurnOptions): void {
  if (options.terminate != null) options.terminate(expectation);
  if (!expectation.isDone) expectation.fail("cancel", "terminated with the turn", "null");
}

function endForced(node: Job, options: CloseTurnOptions): void {
  if (node instanceof AgentCallbackJob || node instanceof AgentNotifyJob) return;
  if (node instanceof CallJob && node.workerSessionId !== "") {
    if (shouldSkipTurnCancel(node, options.catalog)) return;
    options.cancelCall?.(node);
    options.abort?.(node);
    node.cancelled = true;
    node.settleResult(new FailureOutcome({ code: "rejected", message: "rejected" }));
    return;
  }
  if (node instanceof ApprovableJob) {
    if (node.orchestrated) options.abort?.(node);
    node.cancelled = true;
    if (node instanceof CallJob) node.settleResult(new FailureOutcome({ code: "rejected", message: "rejected" }));
    else if (node instanceof ToolCallJob && (node.receiptJson == null || node.receiptJson === "")) {
      node.outcomeSnap = { ok: false, text: "rejected" };
    }
    node.markComplete();
    return;
  }
  if (node instanceof ProgrammaticJob) {
    options.abort?.(node);
    node.outcomeSnap ??= { ok: false, text: "rejected" };
    node.cancelled = true;
    node.markComplete();
  }
}

function endCancelled(node: Job, options: CloseTurnOptions): void {
  if (node instanceof CallJob) {
    if (shouldSkipTurnCancel(node, options.catalog)) return;
    options.releaseCall?.(node);
    rejectLeaf(node);
    if (!node.completed) node.markComplete();
    return;
  }
  if (node instanceof ApprovableJob) {
    if (node.orchestrated) options.abort?.(node);
    rejectLeaf(node);
    if (!node.completed) node.markComplete();
    return;
  }
  if (node instanceof ProgrammaticJob) {
    if (node.orchestrated) options.abort?.(node);
    node.outcomeSnap ??= { ok: false, text: "cancelled" };
    node.cancelled = true;
    node.markComplete();
  }
}

/** Roster names plus live Call worker ids — reattach walks this, not a second index. */
export function namedWorkerIds(root: SessionRoot): readonly string[] {
  const ids = new Set<string>(Object.values(root.botsRoster));
  for (const node of root.motionWork()) {
    if (node instanceof CallJob && node.workerSessionId !== "") ids.add(node.workerSessionId);
  }
  return [...ids];
}

/** Close a cancelled turn. Does not reclaim the worker. */
export function settleCancelledTurn(
  turn: SessionTurn,
  catalog?: CallsCatalog,
  releaseCall?: (call: CallJob) => void,
  session?: SessionRoot,
): void {
  closeTurn(turn, { kind: "cancel" }, { catalog, releaseCall, session });
}

/**
 * The cell the loop had already shifted is still the live seat: an open
 * completion or tool, or a loop token still owed a round (`queuedContinuation`).
 * Claim cells appended behind the token stay claimed.
 *
 * A model round the park or a restart interrupted is not replayed: a
 * CompletionJob is one attempt, and recovery closes it as unknown. The turn
 * gets a fresh round (a new attempt) unless the user stopped it.
 */
export function restorePendingRound(turn: SessionTurn): void {
  if (turn.reducerExited || !turn.orchestrated || turn.completed) return;
  let index = turn.doneWork.length - 1;
  while (index >= 0 && isClaimCell(turn.doneWork[index])) index -= 1;
  const cell = turn.doneWork[index];
  if (cell == null || !interrupted(cell, turn)) return;
  if (cell instanceof CompletionJob && cell.orchestrated) {
    if (turn.cancelRequested) return;
    runInAction(() => turn.enqueue(new ReACTChunk()));
    return;
  }
  runInAction(() => {
    turn.doneWork.splice(index, 1);
    turn.queue.unshift(cell);
  });
}

function isClaimCell(cell: unknown): boolean {
  return (
    cell instanceof TurnSteerChunk || cell instanceof TurnNotificationChunk || cell instanceof TurnApprovalNoteChunk
  );
}

function interrupted(cell: unknown, turn: SessionTurn): boolean {
  if (
    cell instanceof TurnPromptChunk ||
    (cell instanceof ReACTChunk && !cell.skipped) ||
    (cell instanceof CompactJob && !cell.completed)
  ) {
    return turn.queuedContinuation;
  }
  const pew = tapeCompletion(cell);
  if (pew != null) return !pew.isDone;
  return (cell instanceof ProgrammaticJob || cell instanceof ToolCallJob) && !cell.completed;
}
