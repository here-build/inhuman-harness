/**
 * Unattended eval client. Submits one request, watches that turn, never
 * writes `approved`. Authorization stays in the daemon.
 */
import { randomUUID } from "node:crypto";

import { toSExprString } from "@here.build/arrival-serializer";
import { isRpcContractError } from "@inhuman.tools/harness-contract";
import {
  evalProgramOf,
  findEvalTurnByRequestId,
  ProgrammaticJob,
  reactChunks,
  tapeCompletion,
  ToolCallJob,
  type EvalPermissionMode,
} from "@inhuman.tools/harness-model";
import { Client, ObservableAbortSignal } from "@inhuman.tools/harness-sdk";
import {
  applyResolvedAgent,
  hasCliAgentFlags,
  resolveCliAgent,
  stampTermContinue,
  type CliAgentFlags,
  type ShellStreams,
} from "@inhuman.tools/harness-sdk/launch";
import { formatIdentity, receiptPlainText, workCellFace } from "@inhuman.tools/harness-sdk/text";
import { autorun, when } from "mobx";

import { visitEvalProgress } from "./progress.js";

export type EvalPrintFormat = "scheme" | "json";

export type EvalRunOpts = {
  readonly kernel: string;
  readonly project: string;
  readonly expr: string;
  readonly source?: string;
  readonly sourcePath?: string;
  readonly policy: EvalPermissionMode;
  readonly format: EvalPrintFormat;
  readonly agent?: CliAgentFlags;
  readonly streams: ShellStreams;
  /** Start or attach the daemon. The launcher owns that; the shell only asks. */
  readonly ensure: (kernel: string, options?: { readonly restart?: boolean }) => Promise<void>;
};

export async function runEval(opts: EvalRunOpts): Promise<number> {
  const requestId = randomUUID();
  const cancel = new AbortController();
  const abandon = new AbortController();
  const abandoned = ObservableAbortSignal.from(abandon.signal);
  const emitted = new Set<string>();
  let turnId: string | undefined;
  let session: Client | undefined;
  let cancelAcked = false;
  let cancelSending = false;
  let stopWatch: (() => void) | undefined;
  let disposeAbandon: (() => void) | undefined;
  let leaving = false;

  const emit = (work: ProgrammaticJob | ToolCallJob, indent: boolean): void => {
    const sealed =
      work.completed || (work instanceof ToolCallJob && work.receiptJson != null && work.receiptJson !== "");
    if (!sealed || emitted.has(work.uuid)) return;
    emitted.add(work.uuid);
    const face = workCellFace(work, indent ? "inner" : "cell", indent);
    const pad = indent ? "  " : "";
    const width = Math.max(8, (opts.streams.stderr.columns || opts.streams.stdout.columns || 80) - pad.length);
    const line = face.pretty
      ? face.status === ""
        ? face.object
        : `${face.object}  ${face.status}`
      : formatIdentity({ name: face.name, object: face.object, status: face.status }, width, face.pathShaped);
    const parts = [`${pad}${line}`];
    if (face.pretty && face.caption !== "") parts.push(`${pad}${face.caption}`);
    if (face.receipt.kind === "diff") {
      parts.push(`${pad}${face.receipt.path}`, `${pad}${face.receipt.old}`, `${pad}${face.receipt.new}`);
    } else {
      const body = receiptPlainText(face.receipt);
      if (body !== "") parts.push(`${pad}${body}`);
    }
    opts.streams.stderr.write(`${parts.join("\n")}\n`);
  };

  const flushCancel = (): void => {
    const pump = session;
    if (leaving || cancelAcked || cancelSending || pump == null || pump.lost || !cancel.signal.aborted) {
      return;
    }
    cancelSending = true;
    const target = turnId == null ? { requestId } : { turnId };
    void pump.request("turn/cancel", target).then(
      () => {
        cancelAcked = true;
        cancelSending = false;
        return undefined;
      },
      (error) => {
        cancelSending = false;
        if (leaving || pump.lost || isRpcContractError(error) || abandoned.aborted) return undefined;
        flushCancel();
        return undefined;
      },
    );
  };

  const onSignal = (): void => {
    if (!abandoned.aborted) abandon.abort();
    cancel.abort();
    // Exit without waiting on the socket. A blocked tool keeps the daemon from
    // reading, and the send itself then never returns.
    opts.streams.stderr.write("cancellation unconfirmed; execution may still be running\n");
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await opts.ensure(opts.kernel);
    let started: Client;
    if (hasCliAgentFlags(opts.agent ?? {})) {
      await using handle = await Client.kernel(opts.kernel);
      const resolved = await resolveCliAgent(handle, opts.agent ?? {});
      if (!resolved.ok) {
        opts.streams.writeErr(resolved.error);
        return 1;
      }
      started = await Client.start(opts.kernel, opts.project);
      session = started;
      await applyResolvedAgent((method, params) => started.request(method, params), resolved.agent);
    } else {
      started = await Client.start(opts.kernel, opts.project);
      session = started;
    }
    await stampTermContinue(
      (method, params) => started.kernelRequest(method, params),
      process.env,
      started.sessionRoot,
    );
    opts.streams.stderr.write(`connect later with --resume ${started.sessionId}\n`);
    stopWatch = autorun(() => {
      const turn = findEvalTurnByRequestId(started.sessionRoot, requestId);
      if (turn == null) return;
      for (const chunk of reactChunks(turn)) {
        const pew = tapeCompletion(chunk);
        if (pew != null) {
          const text = pew.responseText.trim();
          if (!pew.isDone || text === "" || emitted.has(pew.uuid)) continue;
          emitted.add(pew.uuid);
          opts.streams.stderr.write(`${text}\n`);
          continue;
        }
        if (chunk instanceof ProgrammaticJob) {
          visitEvalProgress(chunk, (id, line) => {
            if (emitted.has(id)) return;
            emitted.add(id);
            opts.streams.stderr.write(`${line}\n`);
          });
          for (const inner of chunk.toolCalls) emit(inner, true);
          emit(chunk, false);
          continue;
        }
        if (chunk instanceof ToolCallJob) emit(chunk, false);
      }
    });
    const evalTurnFailed = (): boolean => {
      const turn = findEvalTurnByRequestId(started.sessionRoot, requestId);
      if (turn == null) return false;
      for (const chunk of reactChunks(turn)) {
        if (chunk instanceof ToolCallJob && chunk.classifierAbstain != null && !chunk.completed) return true;
        if (
          chunk instanceof ProgrammaticJob &&
          chunk.toolCalls.some((inner) => inner.classifierAbstain != null && !inner.completed)
        )
          return true;
      }
      return false;
    };
    if (cancel.signal.aborted) {
      flushCancel();
      return 1;
    }

    const result = await Promise.race([
      started.request("eval", {
        requestId,
        expr: opts.expr,
        policy: opts.policy,
        ...(opts.source != null ? { source: opts.source } : {}),
        ...(opts.sourcePath != null ? { sourcePath: opts.sourcePath } : {}),
      }),
      new Promise<void>((resolve) => {
        disposeAbandon = when(
          () => abandoned.aborted,
          () => resolve(),
        );
      }),
    ]);
    if (abandoned.aborted || cancel.signal.aborted) return 1;
    const admitted = result as { ok: true; turnId: string } | { ok: false; code?: string; text?: string };
    if (admitted.ok !== true) {
      if (!cancel.signal.aborted) opts.streams.writeErr(admitted.text ?? admitted.code ?? "eval failed");
      return 1;
    }
    turnId = admitted.turnId;
    if (cancel.signal.aborted) flushCancel();
    await when(() => {
      if (abandoned.aborted) return true;
      const turn = findEvalTurnByRequestId(started.sessionRoot, requestId);
      if (turn == null) return false;
      if (turn.cancelRequested || turn.cancelled) return true;
      return evalProgramOf(turn)?.completed === true || evalTurnFailed();
    });
    if (cancel.signal.aborted || abandoned.aborted) return 1;
    const turn = findEvalTurnByRequestId(started.sessionRoot, requestId);
    if (turn == null) return 1;
    const snap = evalProgramOf(turn)?.outcomeSnap;
    if (snap == null || !snap.ok || !("value" in snap) || !Array.isArray(snap.value)) return 1;
    if (opts.format === "json") {
      if (typeof snap.jsonError === "string" && snap.jsonError !== "") {
        opts.streams.writeErr(snap.jsonError);
        return 1;
      }
      if ("json" in snap) {
        opts.streams.stdout.write(`${JSON.stringify(snap.json)}\n`);
        return 0;
      }
    }
    if (snap.value.length === 0) return 0;
    const last = snap.value.at(-1);
    const line =
      opts.format === "json"
        ? `${JSON.stringify(last)}\n`
        : typeof last === "string"
          ? `${last}\n`
          : `${toSExprString(last)}\n`;
    opts.streams.stdout.write(line);
    return 0;
  } catch (error) {
    // A lost daemon cannot acknowledge cancellation. Keep the process around
    // for the explicit second interrupt so the caller gets the unconfirmed
    // cancellation warning instead of silently exiting on socket loss.
    if (session?.lost === true || (error instanceof Error && error.message === "rpc: socket closed")) {
      if (!abandoned.aborted) await when(() => abandoned.aborted);
      return 1;
    }
    if (cancel.signal.aborted || abandoned.aborted) return 1;
    opts.streams.writeErr(error);
    return 1;
  } finally {
    leaving = true;
    disposeAbandon?.();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stopWatch?.();
    if (session != null && (session.lost || (!cancel.signal.aborted && !abandoned.aborted))) {
      await session[Symbol.asyncDispose]();
    }
  }
}
