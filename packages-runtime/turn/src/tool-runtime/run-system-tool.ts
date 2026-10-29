/**
 * System-tool BODY. Claimed after an allow-side guard. Outcome lives on
 * the job. This run does not vote. Effect bodies are catalog.execute.
 */
import {
  cancelOutcomeText,
  DEFAULT_SHELL_TAIL_BYTES,
  documentRoot,
  FileMutateToolJob,
  isAbortError,
  isTimeoutAbortReason,
  type JobStopReport,
  parseShellTailBytes,
  outcomeText,
  projectionsOf,
  rememberJobResult,
  RESULT_NOTE_CHARS,
  reportShellTail,
  retractShellTail,
  SessionRoot,
  SystemToolJob,
  writePluginMeta,
} from "@inhuman.tools/harness-model";
import type { ToolOutcomeSnap } from "@inhuman.tools/harness-model/schemas";
import { z } from "zod";

import { externalizePrior } from "./blob-port.js";
import { runWithExtraRoot } from "./extra-root.js";
import { pendingPropose, pluginCallContextOf } from "./plugin-context.js";
import { CONTEXT_RECALL_TOOL_NAME, recallContext } from "./recall.js";
import { ToolError } from "./tool-error.js";
import { workerToolAllowed } from "./worker-tools.js";
import { lineStartOfSpan } from "./write-admit.js";
import { behaviorEntriesOf, catalogOf, requireCatalog } from "../tool-catalog/index.js";

function cancelledSnap(signal: AbortSignal): ToolOutcomeSnap {
  return { ok: false, text: cancelOutcomeText(signal.reason) };
}

const TAIL_MS = 50;

function tailPublisher(job: SystemToolJob): {
  push: (frame: { readonly text: string; readonly totalBytes: number }) => void;
  flush: () => void;
} {
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: { text: string; totalBytes: number } | undefined;
  const send = (frame: { text: string; totalBytes: number }): void => {
    if (job.receiptJson != null && job.receiptJson !== "") return;
    latest = undefined;
    lastAt = Date.now();
    reportShellTail(job, frame);
  };
  return {
    push(frame) {
      const now = Date.now();
      if (now - lastAt >= TAIL_MS) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        send(frame);
        return;
      }
      latest = frame;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (latest !== undefined) send(latest);
      }, TAIL_MS);
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (latest !== undefined) send(latest);
    },
  };
}

/** The captured prior text lands inline or by reference; the other field is cleared, so at most one is set. */
function stampPrior(job: FileMutateToolJob, text: string | null): void {
  if (text === null) {
    job.priorContent = null;
    job.priorBlobJson = null;
    return;
  }
  const stamp = externalizePrior(text);
  if ("priorBlobJson" in stamp) {
    job.priorContent = null;
    job.priorBlobJson = stamp.priorBlobJson;
  } else {
    job.priorContent = stamp.priorContent;
    job.priorBlobJson = null;
  }
}

export function sealToolCall(job: SystemToolJob, outcome: ToolOutcomeSnap): void {
  rememberJobResult(job, outcomeText(outcome), RESULT_NOTE_CHARS);
  job.outcomeSnap ??= outcome;
  retractShellTail(job);
}

function asToolResult(out: unknown): ToolOutcomeSnap {
  if (out != null && typeof out === "object" && "ok" in out) {
    const row = out as {
      ok?: unknown;
      text?: unknown;
      value?: unknown;
      truncated?: unknown;
    };
    if (typeof row.ok === "boolean") {
      return {
        ok: row.ok,
        ...(typeof row.text === "string" ? { text: row.text } : {}),
        ...("value" in row ? { value: row.value } : {}),
        ...(row.truncated === true ? { truncated: true } : {}),
      };
    }
  }
  return { ok: true, value: out };
}

function doorText(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function executeSystemTool(
  job: SystemToolJob,
  signal: AbortSignal,
  opts?: {
    readonly shellTailBytes?: number;
    /** Host list/stop for `job_stop`. The tool body has no job table of its own. */
    readonly stopJob?: (jobId: string) => JobStopReport | Promise<JobStopReport>;
  },
): Promise<void> {
  const seal = (outcome: ToolOutcomeSnap): void => {
    sealToolCall(job, outcome);
  };
  try {
    if (signal.aborted) {
      seal(cancelledSnap(signal));
      return;
    }

    const { toolCallId, name } = job;
    if (toolCallId === "") {
      seal({ ok: false, text: "tool_call snapshot missing toolCallId" });
      return;
    }

    const session = documentRoot(job);
    if (!(session instanceof SessionRoot)) {
      seal({ ok: false, text: "tool_call missing session" });
      return;
    }

    const catalog = requireCatalog(catalogOf(session), name);
    const entry = catalog.catalogEntry(name) ?? behaviorEntriesOf(session).find((row) => row.wireName === name);
    if (session.agent.spec.name !== "" && !workerToolAllowed(catalog, session.agent.spec.name, name, session)) {
      seal({ ok: false, text: "outside worker tool ceiling" });
      return;
    }
    job.regenerateable = entry?.class === "read";
    if (signal.aborted) {
      seal(cancelledSnap(signal));
      return;
    }

    const raw = job.invocation();
    const args = job.args ?? (raw === "" ? {} : null);
    if (args == null) {
      seal({
        ok: false,
        text: `${name}: arguments were not valid JSON — ${raw.slice(0, 200)}`,
      });
      return;
    }

    if (name === CONTEXT_RECALL_TOOL_NAME) {
      seal(recallContext(session, args));
      return;
    }

    if (name === "job_stop") {
      const jobIdRaw = args.job_id;
      const jobId = typeof jobIdRaw === "string" ? jobIdRaw : "";
      const report = await (opts?.stopJob?.(jobId) ?? {
        ok: false as const,
        text: "job_stop is not available on this host",
      });
      seal(report);
      return;
    }

    const root = session.path.trim() === "" ? process.cwd() : session.path;
    // Extra-root follows the license, not the human bit. Yolo and auto
    // remainder leave approved null; writing it here would derive HITL.
    // block never licenses. A folder the human said to treat as part of the session is a floor approve for
    // reads under it (a session read root), so it opens the same door through `licenseAllows`; nothing is remembered
    // from a single outside read.
    const tailBytes = parseShellTailBytes(opts?.shellTailBytes ?? DEFAULT_SHELL_TAIL_BYTES);
    const live = name === "shell" && tailBytes > 0 ? tailPublisher(job) : undefined;
    let dispatched: unknown;
    try {
      ToolError.invariant(entry?.execute, () =>
        name.startsWith("mcp__")
          ? `unknown MCP tool "${name}" — connection missing, disabled, or not expanded`
          : `unknown tool "${name}" — available: ${catalog.catalogWireNames().join(", ")}`,
      );
      try {
        dispatched = await runWithExtraRoot(job.licenseAllows, () =>
          entry.execute!(args, {
            root,
            catalog,
            signal,
            sessionId: session.sessionId,
            onPriorContent:
              job instanceof FileMutateToolJob
                ? (text) => {
                    stampPrior(job, text);
                    if (typeof text === "string" && name === "edit_file") {
                      const old = typeof args.old_string === "string" ? args.old_string : "";
                      const line = lineStartOfSpan(text, old);
                      if (line != null) job.priorLineStart = line;
                    }
                  }
                : undefined,
            shellTailBytes: tailBytes,
            onTail: live?.push,
            ...pluginCallContextOf(session, job, signal, entry.source.kind === "pack" ? entry.source.pluginName : ""),
          }),
        );
      } catch (error) {
        if (error instanceof ToolError) throw error;
        dispatched = {
          ok: false,
          text: error instanceof z.ZodError ? doorText(error) : `${name}: ${doorText(error)}`,
        };
      }
    } finally {
      live?.flush();
    }
    const proposed = pendingPropose.get(job);
    pendingPropose.delete(job);
    if (proposed != null) {
      const projection = projectionsOf(job).get(proposed.pluginId);
      if (projection?.hostOnly?.(proposed.action) === true) {
        seal({ ok: false, text: `${proposed.pluginId}: host-only metadata` });
        return;
      }
      writePluginMeta(job, proposed.pluginId, proposed.action, false);
    }
    seal(asToolResult(dispatched));
  } catch (error) {
    if (signal.aborted) {
      seal(cancelledSnap(signal));
      return;
    }
    if (error instanceof ToolError) {
      seal({ ok: false, text: error.message });
      return;
    }
    if (isAbortError(error) && !isTimeoutAbortReason(error)) {
      seal({ ok: false, text: cancelOutcomeText(error) });
      return;
    }
    seal({ ok: false, text: `error: ${error instanceof Error ? error.message : String(error)}` });
  }
}
