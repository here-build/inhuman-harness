/**
 * Order of the calls in one model response, as data. Each call gets an `after`
 * list of earlier calls in the same response; the orchestrator claims a job only
 * once those are released. Nothing here schedules, so the order is the same after
 * a restart.
 *
 * Lanes:
 * - `local`: shell, edits and writes, local (stdio) MCP, and Scheme programs.
 *   One chain in response order.
 * - `server`: a third-party MCP server. A read-only call waits only for earlier
 *   writes to that server; any other call waits for every earlier call to it.
 * - `free`: read-only built-ins, web, comms, side channels, and sealed calls.
 *
 * A path read (`read_file`, `list_dir`, `grep`, `glob`, `fff_search`) is a `free`
 * call with one exception: it also waits for every earlier `write_file` /
 * `edit_file` in the same response whose path it may touch, so it never reads a
 * file before the model's own edit of it has landed. A path that cannot be
 * compared (a missing one, or relative against absolute) counts as touching.
 *
 * When a call cannot be classified it is not read-only: unknown tools are
 * `local`, and an MCP call is read-only only when the catalog class says `read`
 * and the name floor reads it as a look-up.
 */
import type { Job } from "@inhuman.tools/plexus-expectations";

import { clusterOf, fileQuestion } from "./cluster.js";
import { AgentCallbackJob } from "./jobs/AgentCallbackJob.js";
import { AgentMessageJob } from "./jobs/AgentMessageJob.js";
import { AgentNotifyJob } from "./jobs/AgentNotifyJob.js";
import { CallJob } from "./jobs/CallJob.js";
import { ContextNeedToolJob } from "./jobs/ContextNeedToolJob.js";
import { MCPToolJob } from "./jobs/MCPToolJob.js";
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { SystemToolJob } from "./jobs/SystemToolJob.js";
import { WebExtractToolJob } from "./jobs/WebExtractToolJob.js";
import { WebSearchToolJob } from "./jobs/WebSearchToolJob.js";
import { mcpReadFloorAllows } from "./mcp-name-floor.js";

export type CallLane =
  | { readonly kind: "free" }
  | { readonly kind: "local" }
  | { readonly kind: "server"; readonly key: string; readonly readOnly: boolean };

export type CallOrderFacts = {
  /** Catalog class of a wire name: `read` | `write` | `effect` | `meta`. Undefined when not in the catalog. */
  readonly entryClass: (wireName: string) => string | undefined;
  /** A third-party server, reached over the network. Anything else, or unknown, is local. */
  readonly remoteMcp: (connectionKey: string) => boolean;
};

export function callLaneOf(job: Job, facts: CallOrderFacts): CallLane {
  if (job.completed || job.cancelled) return { kind: "free" };
  if (job instanceof MCPToolJob) {
    if (!facts.remoteMcp(job.connectionKey)) return { kind: "local" };
    const readOnly = facts.entryClass(job.name) === "read" && mcpReadFloorAllows(job.serverToolName);
    return { kind: "server", key: job.connectionKey, readOnly };
  }
  if (job instanceof ProgrammaticJob) return { kind: "local" };
  if (
    job instanceof CallJob ||
    job instanceof AgentCallbackJob ||
    job instanceof AgentMessageJob ||
    job instanceof AgentNotifyJob ||
    job instanceof ContextNeedToolJob ||
    job instanceof WebSearchToolJob ||
    job instanceof WebExtractToolJob
  ) {
    return { kind: "free" };
  }
  if (job instanceof SystemToolJob) {
    if (job.isSideChannel) return { kind: "free" };
    const cluster = clusterOf(job.name);
    if (cluster === "read") return { kind: "free" };
    if (cluster === "bash" || cluster === "write") return { kind: "local" };
    const entry = facts.entryClass(job.name);
    return entry === "read" || entry === "meta" ? { kind: "free" } : { kind: "local" };
  }
  return { kind: "local" };
}

/** What a file tool does to which path. `path` null means "wherever the tool defaults to". */
export type FileAccess = { readonly mode: "read" | "write"; readonly path: string | null };

export type PlacedCall = { readonly job: Job; readonly lane: CallLane; readonly file?: FileAccess };

/** The file a built-in tool reads or writes, or null when the job is not a file tool. */
export function fileAccessOf(job: Job): FileAccess | null {
  if (!(job instanceof SystemToolJob) || job.completed || job.cancelled) return null;
  const cluster = clusterOf(job.name);
  if (cluster !== "read" && cluster !== "write") return null;
  return { mode: cluster === "read" ? "read" : "write", path: fileQuestion(job.name, job.args) };
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return `${value.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

/** Whether a read of `read` can see what a write to `write` changes. Unknown means yes. */
export function pathsOverlap(read: string | null, write: string | null): boolean {
  if (read == null || write == null) return true;
  if (read.startsWith("~") || write.startsWith("~")) return true;
  if (read.startsWith("/") !== write.startsWith("/")) return true;
  const a = normalizePath(read);
  const b = normalizePath(write);
  if (a === b || a === "" || b === "" || a === "/" || b === "/") return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Earlier file writes a read of `access.path` has to wait for. */
function writesBefore(access: FileAccess, earlier: readonly PlacedCall[]): Job[] {
  return earlier
    .filter((call) => call.file?.mode === "write" && pathsOverlap(access.path, call.file.path))
    .map((call) => call.job);
}

/** The earlier calls `lane` has to wait for. */
export function callAfter(lane: CallLane, earlier: readonly PlacedCall[]): Job[] {
  switch (lane.kind) {
    case "free":
      return [];
    case "local":
      return earlier.filter((call) => call.lane.kind === "local").map((call) => call.job);
    case "server":
      return earlier
        .filter(
          (call) =>
            call.lane.kind === "server" && call.lane.key === lane.key && (!lane.readOnly || !call.lane.readOnly),
        )
        .map((call) => call.job);
  }
}

/** Calls of one response, placed in the order the model wrote them. */
export class ResponseCallOrder {
  readonly #placed: PlacedCall[] = [];

  constructor(readonly facts: CallOrderFacts) {}

  /** Stamp `after` on `job` from the calls placed so far. Call before the job is reachable. */
  place(job: Job): CallLane {
    const lane = callLaneOf(job, this.facts);
    const file = fileAccessOf(job) ?? undefined;
    const after = callAfter(lane, this.#placed);
    if (file?.mode === "read") {
      for (const write of writesBefore(file, this.#placed)) if (!after.includes(write)) after.push(write);
    }
    if (after.length > 0) job.stampAfter(after);
    this.#placed.push({ job, lane, file });
    return lane;
  }
}
