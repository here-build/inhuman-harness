/**
 * Scheme-repl verbs. Module singleton: job, host, rig, and tools are
 * configuration, read when a verb runs.
 *
 * Calls look synchronous; Arrival's trampoline fans out independent host
 * promises. Background is an outer tool arg, not a verb — the ProgrammaticJob
 * is foreground or background as a whole.
 *
 * Config is the stable bag (writable, host, tools, loader, prompt, keyOf). The
 * interpreter adds job and rig at arm and mutates the rig in place. The
 * vocabulary memo keys on capability identity plus that object, so a watch
 * tick does not re-bake.
 *
 * Toolkit we own: required positionals, optional trailing dict. Ask schemas are
 * Arrival s/* tagged lists (`schemaCapability`); this pack does not mint a
 * second type wire. Pack-tool *names* are not known at `define()`, so they bind
 * as their own symbols on a per-catalog overlay onto the same `call` substrate.
 * `mcp/call` is catalog lookup onto that same `call`. Connection and tool
 * are positionals; the last argument stays Arrival `inputRest` as `sz.dynamic`
 * so a trailing dict and `:k v` pairs both land — a record kwargs shape
 * would drop unknown MCP keys. Closed toolkit verbs (list_dir, grep, write/edit,
 * shell, web_search, web_extract) keep their positionals and take a `sz.dynamic`
 * rest through `keywordsOf`. A record `inputRest` is keywords only and drops
 * the positional input. `read_file` stays native and peels its own rest.
 * bot/send, and bot/ask when it names a spec, construct
 * BotCallJob. agent/call, agent/ask, and an omitted-spec bot/ask construct
 * AgentCallJob. The job name stays agent__send or agent__ask; the class owns
 * the worker, so these verbs do not mint oneShot. The verb `registerJob`s the
 * job it constructed. Pack bot-call tools, worker replies, and ordinary host
 * tools still admit, then `registerJob` the leaf. A `.prompt` on this program
 * constructs an AgentCallJob the same way. Spec/message/[schema]
 * stay positional; `:readonly` and `:model` are Arrival kwargs on `inputRest`.
 * `:model` is `"connection/model"` and pins that disposable worker.
 * `connection/models` lists a wire's live ids.
 * Comms are the same call onto agent__* wires. `agent/respond` is a
 * notImplemented door — settle with the `agent__respond` JSON tool.
 * `self/notify` is an origin atom on this bag (or the enclosing Call); it does
 * not settle. Bag-home atoms recall only when the bag is background; a sitter
 * writes the enclosing Call.
 */
import {
  type CallCtx,
  EnvCapability,
  isSchemeValue,
  type SchemeValue,
  type SymbolDeclaration,
  toJS,
} from "@here.build/arrival";
import { schemaCapability } from "@here.build/arrival/capabilities/schema";
import { ANil, AString } from "@here.build/arrival/reflect-internals";
import { tagToJsonSchema } from "@here.build/arrival/schema-tag";
import { type Loader, arrivalLoaderCapability } from "@here.build/arrival-modules";
import { arrivalYamlCapability } from "@here.build/arrival-modules/yaml";
import { toSExprString } from "@here.build/arrival-serializer";
import { promptProgramCapability, type PromptComplete } from "@inhuman.tools/env-capability-module-prompt";
import {
  AGENT_ASK,
  AGENT_MESSAGE,
  AGENT_NOTIFY,
  AGENT_SEND,
  AGENT_VOID,
  AgentCallJob,
  type AgentCallNotification,
  ApprovableJob,
  AutonomousToolError,
  BotCallJob,
  cancelOutcomeText,
  claimCrossing,
  crossingPending,
  crossingWindow,
  isReplaying,
  ProgrammaticJob,
  SCHEME_REPL_NAMING,
  SCHEME_REPL_TOOL_NAME,
  SCHEME_WATCH_TOOL_NAME,
  UPDATE_METADATA_TOOL_NAME,
  type SessionRoot,
  takeCrossing,
  ToolCallJob,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type WorkflowLeafMeta,
} from "@inhuman.tools/harness-model";
import {
  appendNotify,
  failureCodeOf,
  programRuntimeOf,
  recordedModuleLoader,
  SchemeReplToolFailure,
  type ProgramHost,
  type ProgramRuntime,
} from "@inhuman.tools/scheme-program";
import type { BoundTool } from "@inhuman.tools/substrate/bound-tool";
import { DoorSession, internalCallBudgetDoor, unknownToolDoor } from "@inhuman.tools/substrate/doors";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import type { KernelToolCatalog } from "@inhuman.tools/turn/catalog";
import { runInAction, when } from "mobx";
import invariant from "tiny-invariant";
import { z } from "zod";

import { boundToolsOf } from "./bound-tools.js";
import { stampFilePath } from "./file-path.js";
import { isKeyword, keywordsOf, splitKeywords } from "./keywords.js";
import { DEFAULT_SCHEME_REPL_LIMITS } from "./limits.js";

/** Wire name. Do not import the builtin roster just for this token. */
const SHELL_TOOL_NAME = "shell";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SchemeReplHost = {
  /** Absent on a replay host, which binds `replayTools` and never admits. */
  readonly catalog?: KernelToolCatalog;
  readonly root: string;
  /** Match recorded children. Missing is an error, and nothing is minted. */
  readonly replayOnly?: boolean;
  /** Pack names recorded on the job. Replaces the daemon catalog. */
  readonly replayTools?: ReadonlyMap<string, BoundTool>;
  /** Disk `require`. Replay leaves this unset and reads `job.modules`. */
  readonly loadSource?: (root: string, job: ProgrammaticJob) => Loader;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly session?: SessionRoot;
  readonly doors: DoorSession;
  readonly admit: (call: ToolCall) => ToolCallJob | ProgrammaticJob;
  readonly abort?: (leaf: ApprovableJob, reason?: unknown) => void;
  /** Origin atom. Default writes `job.notifications`. Orchestrator may XOR onto an enclosing Call. */
  readonly notify?: (note: AgentCallNotification) => void;
  /** Watch key. Omit → pack provenance from the per-tick tap. */
  readonly keyOf?: (value: unknown) => string | undefined;
  /** Ask desk. Bound-tools allowlist drops write/edit; shell stays. */
  readonly readonly?: boolean;
  /** Live model ids for `(connection/models)`. Missing name throws. */
  readonly connectionModels?: (connection: string) => readonly string[];
  /** Wraps each run so the daemon owns its trace; see `ProgramHost.observe`. */
  readonly observe?: ProgramHost["observe"];
  /** Unattended eval. Honors `source` / `sourcePath` on the bag. */
  readonly evalProgram?: boolean;
  /** Override jail root. Default is `dirname(sourcePath)`. */
  readonly moduleRoot?: string;
  readonly complete?: PromptComplete;
  readonly connectionId?: string;
  readonly completionModel?: string;
};

/** Per-tick. Verbs read it when they run; it is not baked into the capability. */
type ReplRig = {
  signal: AbortSignal;
  origin: number;
  replayAt: number;
  /** toolCalls length at the start of the current top-level statement. */
  formAt: number;
  maxInternalCalls: number | undefined;
  failureCode: string | undefined;
};

function isSchemeReplHost(value: unknown): value is SchemeReplHost {
  if (value === null || typeof value !== "object") return false;
  const rec = value as SchemeReplHost;
  return typeof rec.admit === "function" && rec.doors != null && (rec.catalog != null || rec.replayTools != null);
}

function isReplRig(value: unknown): value is ReplRig {
  if (value === null || typeof value !== "object") return false;
  return typeof (value as ReplRig).replayAt === "number";
}

const replConfiguration = {
  writable: z.boolean().optional(),
  job: z.custom<ProgrammaticJob>((value) => value === undefined || value instanceof ProgrammaticJob).optional(),
  host: z.custom<SchemeReplHost>((value) => value === undefined || isSchemeReplHost(value)).optional(),
  rig: z.custom<ReplRig>((value) => value === undefined || isReplRig(value)).optional(),
  tools: z.custom<ReadonlyMap<string, BoundTool>>((value) => value === undefined || value instanceof Map).optional(),
};

type ReplConfig = {
  job?: ProgrammaticJob;
  host?: SchemeReplHost;
  rig?: ReplRig;
  tools?: ReadonlyMap<string, BoundTool>;
};

type ReplActivation = {
  invocation?: CallCtx["invocation"];
  configuration?: unknown;
  runCtx?: { capabilityConfigurations?: { get(key: object): unknown } };
};

function isReplConfig(value: unknown): value is ReplConfig {
  if (value === null || typeof value !== "object") return false;
  return isSchemeReplHost((value as ReplConfig).host);
}

/** Direct dispatch has `this.configuration`. HOF (`map read_file`) omits it; the
 *  run table is keyed on the singleton capability object. */
function configured(ctx: ReplActivation): ReplConfig {
  if (isReplConfig(ctx.configuration)) return ctx.configuration;
  const mapped = ctx.runCtx?.capabilityConfigurations?.get(schemeReplCapability);
  if (isReplConfig(mapped)) return mapped;
  throw new Error("scheme-repl: host is not configured");
}

function replBag(ctx: ReplActivation): {
  job: ProgrammaticJob;
  host: SchemeReplHost;
  rig: ReplRig;
  tools: ReadonlyMap<string, BoundTool>;
} {
  const { job, host, rig, tools } = configured(ctx);
  invariant(job instanceof ProgrammaticJob, "scheme-repl: job is not configured");
  invariant(isSchemeReplHost(host), "scheme-repl: host is not configured");
  invariant(isReplRig(rig), "scheme-repl: rig is not configured");
  invariant(tools instanceof Map, "scheme-repl: tools are not configured");
  return { job, host, rig, tools };
}

export type ReplRuntime = ProgramRuntime;

/** Arrival `isSchemeValue` is Boxed (Macro/Syntax/Function); `toJS` wants SchemeValue. */
function toJsValue(value: unknown): unknown {
  return isSchemeValue(value) ? toJS(value as SchemeValue) : value;
}

function argsOf(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    out[key] = toJsValue(value);
  }
  return out;
}

function jsRecord(record: Record<string, unknown> | undefined): Record<string, unknown> {
  return record === undefined ? {} : argsOf(record);
}

/** Open MCP keys cannot use a record `inputRest` — Arrival drops unknown kwargs.
 *  Native contour also does not fold `:k v` (no membrane decode). Both peel
 *  `sz.dynamic` rest / leftover args as a trailing dict or even `:k v` pairs. */
function restKwargs(rest: readonly unknown[], verb: string): Record<string, unknown> {
  if (rest.length === 0) return {};
  if (rest.length === 1) {
    const js = toJsValue(rest[0]);
    if (isPlainRecord(js) && !isSchemeValue(js)) return argsOf(js);
    throw new Error(`${verb}: last argument must be a dict or :key value pairs`);
  }
  if (rest.length % 2 !== 0) {
    throw new Error(`${verb}: dangling keyword`);
  }
  const out: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i += 2) {
    out[String(rest[i]).replace(/^:/, "")] = toJsValue(rest[i + 1]);
  }
  return out;
}

function stringOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof AString) return value.valueOf();
  return String(toJsValue(value));
}

function isStringLike(value: unknown): boolean {
  if (typeof value === "string" || value instanceof AString) return true;
  return typeof toJsValue(value) === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const METADATA_KEYWORDS = {
  current_turn_title: z.any().optional(),
  current_turn_description: z.any().optional(),
};

function metadataBlank(value: unknown): boolean {
  if (value == null || value instanceof ANil) return true;
  const js = toJsValue(value);
  return js == null || js instanceof ANil;
}

function metadataString(value: unknown, field: string): string {
  const js = toJsValue(value);
  if (typeof js !== "string") throw new Error(`update_metadata: ${field} must be a string`);
  return js;
}

/** Positional title and description, a keyword tail, or one dict. */
function metadataArgs(slots: readonly unknown[]): Record<string, unknown> {
  if (slots.length === 1) {
    const sole = toJsValue(slots[0]);
    if (isPlainRecord(sole)) return metadataRecord(sole);
  }
  const { positionals, keywords } = splitKeywords(UPDATE_METADATA_TOOL_NAME, slots, METADATA_KEYWORDS);
  if (positionals.length > 2) throw new Error("update_metadata: at most a title and a description");
  const titleSlot = keywords.current_turn_title ?? positionals[0];
  if (metadataBlank(titleSlot)) throw new Error("update_metadata: current_turn_title is required");
  const described =
    keywords.current_turn_description !== undefined ? keywords.current_turn_description : positionals[1];
  const out: Record<string, unknown> = { current_turn_title: metadataString(titleSlot, "current_turn_title") };
  if (!metadataBlank(described)) {
    out.current_turn_description = metadataString(described, "current_turn_description");
  }
  return out;
}

function metadataRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (metadataBlank(record.current_turn_title)) throw new Error("update_metadata: current_turn_title is required");
  const out: Record<string, unknown> = {
    current_turn_title: metadataString(record.current_turn_title, "current_turn_title"),
  };
  if (!metadataBlank(record.current_turn_description)) {
    out.current_turn_description = metadataString(record.current_turn_description, "current_turn_description");
  }
  return out;
}

function workerSpec(verb: string, slot: unknown): string {
  if (isKeyword(slot)) throw new Error(`${verb}: the worker spec comes before keywords, got ${String(slot)}`);
  const spec = stringOf(slot).trim();
  if (spec === "") throw new Error(`${verb}: a worker spec is required`);
  return spec;
}

function shellCwd(rest: readonly unknown[]): string {
  if (rest.length === 1 && isPlainRecord(rest[0]) && !isKeyword(rest[0])) {
    const cwd = rest[0].cwd;
    return cwd === undefined ? "." : stringOf(cwd);
  }
  const at = rest.findIndex((arg) => isKeyword(arg) && String(arg) === ":cwd");
  const value = at === -1 ? undefined : rest[at + 1];
  return value === undefined ? "." : stringOf(value);
}

function compiledAskSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const js = toJsValue(value);
  if (typeof js === "string" || Array.isArray(js)) return tagToJsonSchema(js);
  if (!isPlainRecord(js)) throw new Error("ask schema: expected a type or field dict");
  if (typeof js.type === "string") return js;
  return tagToJsonSchema(["object", ...Object.entries(js).map(([name, type]) => [name, type])]);
}

function fsPath(path: string): readonly (readonly string[])[] {
  return [["fs", path]];
}

function abortThrow(signal: AbortSignal): Error {
  const text = cancelOutcomeText(signal.reason);
  return new Error(text === "cancelled" ? "Scheme REPL call cancelled" : text);
}

function rawOutcome(snap: { readonly text?: string; readonly value?: unknown }): unknown {
  if ("value" in snap) return snap.value;
  return snap.text;
}

function sexpr(value: unknown): string {
  try {
    return toSExprString(value as SchemeValue);
  } catch {
    return JSON.stringify(value);
  }
}

/** What a settled inner call actually returned. Not the Scheme value the form would have produced. */
function rawCallLine(inner: ToolCallJob): string {
  const snap = inner.outcomeSnap;
  const name = inner.name.trim() === "" ? "tool" : inner.name.trim();
  const args = sexpr(inner.args ?? {});
  if (snap === undefined || !inner.completed) return `${name} ${args} — no outcome`;
  if (!snap.ok) {
    const own = typeof snap.text === "string" ? snap.text.trim() : "";
    const raw = sexpr(rawOutcome(snap));
    return `${name} ${args} — ${own !== "" ? own : raw}; raw ${raw}`;
  }
  return `${name} ${args} — raw ${sexpr(rawOutcome(snap))}`;
}

/**
 * The failing call is not a Scheme result, so name it: arguments, the tool's own
 * error, and the raw outcomes of the other calls this statement already made.
 */
function toolFailureReport(
  job: ProgrammaticJob,
  failed: ToolCallJob,
  snap: { readonly text?: string; readonly value?: unknown; readonly code?: string },
  formAt: number,
): string {
  const name = failed.name.trim() === "" ? "tool" : failed.name.trim();
  const own = typeof snap.text === "string" ? snap.text.trim() : "";
  const raw = sexpr(rawOutcome(snap));
  const detail = own !== "" ? own : raw;
  const siblings = job.toolCalls.slice(formAt).filter((inner) => inner !== failed && inner.completed);
  const lines = [`${name} ${sexpr(failed.args ?? {})} failed: ${detail}`, `raw ${raw}`];
  if (siblings.length > 0) {
    lines.push(
      "Other tool calls in this statement already settled. Their raw results are not part of the statement's value:",
      ...siblings.map((inner) => rawCallLine(inner)),
    );
  }
  return lines.join("\n");
}

function resultFromSnap(job: ProgrammaticJob, inner: ToolCallJob, formAt: number): unknown {
  const snap = inner.outcomeSnap;
  invariant(snap !== undefined, `${inner.name} sealed without an outcome`);
  if (!snap.ok) {
    throw new SchemeReplToolFailure(toolFailureReport(job, inner, snap, formAt), snap.code);
  }
  const out: unknown = "value" in snap ? snap.value : typeof snap.text === "string" ? snap.text : undefined;
  if (!Array.isArray(out)) return out;
  const max = DEFAULT_SCHEME_REPL_LIMITS.maxAttachments;
  let seen = 0;
  return out.map((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return block;
    const type = "type" in block ? block.type : undefined;
    if (type !== "image" && type !== "audio" && type !== "resource") return block;
    seen += 1;
    if (seen <= max) return block;
    return { type: "text", text: `[attachment omitted: quota ${max}]` };
  });
}

function readToolResult(job: ProgrammaticJob, inner: ToolCallJob, rig: ReplRig, formAt: number): unknown {
  try {
    return resultFromSnap(job, inner, formAt);
  } catch (error) {
    const code = failureCodeOf(error);
    if (code != null) rig.failureCode = code;
    throw error;
  }
}

/** Abort-win leaves `inner` to seal on its own. */
async function joinInner(inner: ToolCallJob, signal: AbortSignal): Promise<"settled" | "aborted"> {
  if (signal.aborted || inner.cancelled) return "aborted";
  if (inner.completed) return "settled";
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const joined = when(() => inner.completed || inner.cancelled);
  try {
    const result = await Promise.race([
      joined.then(
        () => "settled" as const,
        () => "aborted" as const,
      ),
      aborted,
    ]);
    if (result === "aborted" || inner.cancelled) return "aborted";
    return "settled";
  } finally {
    joined.cancel();
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function resolveToolName(
  host: SchemeReplHost,
  tools: ReadonlyMap<string, BoundTool>,
  connection: string,
  tool: string,
): string {
  const catalog = host.catalog;
  invariant(catalog != null, "scheme-repl: catalog is not configured");
  for (const entry of catalog.catalogEntries()) {
    if (entry.source.kind !== "connection") continue;
    if (!tools.has(entry.wireName)) continue;
    if (entry.source.connectionKey === connection && entry.source.serverToolName === tool) {
      return entry.wireName;
    }
  }
  const attempted = `${connection}/${tool}`;
  throw new Error(
    host.doors.render(unknownToolDoor(attempted, [...tools.keys()], tools, SCHEME_REPL_NAMING), attempted),
  );
}

async function callTool(
  job: ProgrammaticJob,
  host: SchemeReplHost,
  rig: ReplRig,
  tools: ReadonlyMap<string, BoundTool>,
  name: string,
  toolArgs: Record<string, unknown>,
  cross: Crossing,
  ctx: CallCtx,
): Promise<unknown> {
  const { signal } = rig;
  if (signal.aborted || job.cancelled) throw abortThrow(signal);
  invariant(
    name !== SCHEME_REPL_TOOL_NAME && name !== SCHEME_WATCH_TOOL_NAME,
    `${name} cannot be invoked inside scheme_repl`,
  );
  // Replay matches the recorded child by track. The wire name was resolved when it was minted.
  if (!host.replayOnly) {
    const catalog = host.catalog;
    invariant(catalog != null, "scheme-repl: catalog is not configured");
    const entry = catalog.catalogEntry(name);
    if (entry != null && entry.packMeta?.kind === "bot-call") throw new AutonomousToolError(name);
    invariant(entry !== undefined && tools.has(name), () =>
      host.doors.render(unknownToolDoor(name, [...tools.keys()], tools, SCHEME_REPL_NAMING), name),
    );
  }
  return joinMinted(job, host, rig, name, cross, ctx, () => {
    const minted = host.admit({
      id: innerToolCallId(job),
      type: "function",
      function: { name, arguments: JSON.stringify(toolArgs) },
    });
    invariant(minted instanceof ToolCallJob, `${name} cannot be invoked inside scheme_repl`);
    job.registerJob(minted);
    return minted;
  });
}

function innerToolCallId(job: ProgrammaticJob): string {
  return `${job.toolCallId === "" ? "program" : job.toolCallId}:inner:${job.toolCalls.length + 1}`;
}

/**
 * What the program's graph learns of a crossing. Taken while the verb is still on
 * its own stack, where `currentInvocation` is the call; stamped once the inner job
 * is known, which is before the call is awaited, so a running call is already a leaf.
 */
type Crossing = (inner: ToolCallJob) => void;

function stringList(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("replay: connection/models record is not a list of strings");
  const ids: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") throw new Error("replay: connection/models record is not a list of strings");
    ids.push(item);
  }
  return ids;
}

/** A card shows a line or two; the whole text stays on the inner job, so the feed carries a glance. */
const GLANCE_CHARS = 280;
const glance = (value: unknown): unknown =>
  typeof value === "string" && value.length > GLANCE_CHARS ? `${value.slice(0, GLANCE_CHARS)}…` : value;

function crossing(ctx: ReplActivation, full: Omit<WorkflowLeafMeta, "jobId">): Crossing {
  const meta = {
    ...full,
    ...(full.message === undefined ? {} : { message: glance(full.message) as string }),
    ...(full.args === undefined
      ? {}
      : { args: Object.fromEntries(Object.entries(full.args).map(([key, arg]) => [key, glance(arg)])) }),
  };
  const inv = ctx.invocation?.currentInvocation;
  return (inner) => {
    if (inv === undefined) return;
    inv.markProvenancePoint?.();
    // A job outside any document (a host test's) has no uuid yet; the card just lacks its link.
    let jobId: string | undefined;
    try {
      jobId = inner.uuid;
    } catch {
      /* unmaterialized */
    }
    inv.setMetadata?.({ ...meta, ...(jobId === undefined ? {} : { jobId }) } satisfies WorkflowLeafMeta);
  };
}

function budgetDoor(host: SchemeReplHost, rig: ReplRig, job: ProgrammaticJob): void {
  if (rig.maxInternalCalls == null || job.toolCalls.length - rig.origin < rig.maxInternalCalls) return;
  const tool = job.toolName === "" ? SCHEME_REPL_TOOL_NAME : job.toolName;
  throw new Error(host.doors.render(internalCallBudgetDoor(rig.maxInternalCalls, tool), tool));
}

async function finishJoined(
  job: ProgrammaticJob,
  rig: ReplRig,
  formAt: number,
  inner: ToolCallJob,
  cross: Crossing,
): Promise<unknown> {
  cross(inner);
  if (!inner.completed && (await joinInner(inner, rig.signal)) === "aborted") throw abortThrow(rig.signal);
  return readToolResult(job, inner, rig, formAt);
}

/**
 * A tracked run claims its path before the wait, then takes the child stamped with it.
 * A job from before tracks still walks `toolCalls` by position and name.
 * `mint` parents the job.
 */
async function joinMinted(
  job: ProgrammaticJob,
  host: SchemeReplHost,
  rig: ReplRig,
  name: string,
  cross: Crossing,
  ctx: CallCtx,
  mint: () => ToolCallJob,
): Promise<unknown> {
  const { signal } = rig;
  if (signal.aborted || job.cancelled) throw abortThrow(signal);
  const formAt = rig.formAt;
  const emission = ctx.runCtx.emission;
  if (job.trackMatch && emission != null) {
    const path = claimCrossing(emission, crossingWindow(ctx));
    let replay = takeCrossing(job, emission, path);
    if (replay == null && (host.replayOnly === true || isReplaying(emission))) {
      if (!job.completed && !job.cancelled && !signal.aborted) {
        const joined = when(
          () => job.completed || job.cancelled || signal.aborted || crossingPending(job, emission, path),
        );
        try {
          await joined;
        } finally {
          joined.cancel();
        }
      }
      if (signal.aborted || job.cancelled) throw abortThrow(signal);
      replay = takeCrossing(job, emission, path);
      if (replay == null) throw new Error(`replay: no recorded ${name}`);
    }
    if (replay != null) return finishJoined(job, rig, formAt, replay, cross);
    budgetDoor(host, rig, job);
    const minted = mint();
    runInAction(() => (minted.track = path));
    rig.replayAt = job.toolCalls.length;
    return finishJoined(job, rig, formAt, minted, cross);
  }
  const replay = job.toolCalls[rig.replayAt];
  if (replay != null && replay.name === name) {
    rig.replayAt += 1;
    return finishJoined(job, rig, formAt, replay, cross);
  }
  budgetDoor(host, rig, job);
  const minted = mint();
  rig.replayAt = job.toolCalls.length;
  return finishJoined(job, rig, formAt, minted, cross);
}

/**
 * Standing bot when `standing` and the spec is non-blank; otherwise an owned child.
 * Args stay the message bag: spec, message, and `:model`. Ask flags live on the job.
 */
function spawnCall(
  ctx: CallCtx,
  name: typeof AGENT_SEND | typeof AGENT_ASK,
  standing: boolean,
  spec: string | undefined,
  message: string,
  flags: {
    /** The verb the program wrote; `name` is the wire it lowers to. */
    readonly verb: string;
    readonly deskReadonly?: boolean;
    readonly schema?: Record<string, unknown>;
    readonly model?: string;
  },
): Promise<unknown> {
  const { job, host, rig } = replBag(ctx);
  const raw = spec ?? "";
  const trimmed = raw.trim();
  const args: Record<string, unknown> = {};
  if (trimmed !== "") args.spec = raw;
  args.message = message;
  const model = flags.model?.trim() ?? "";
  if (model !== "") args.model = model;
  const props = {
    name,
    argsJson: JSON.stringify(args),
    voidLegal: name === AGENT_SEND,
    readonly: flags.deskReadonly === true,
    responseSchema: flags.schema ?? null,
  };
  const bot = standing && trimmed !== "";
  const cross = crossing(ctx, {
    kind: bot ? "bot" : "agent",
    verb: flags.verb,
    name: trimmed,
    ...(model === "" ? {} : { model }),
    message,
    ...(job.background ? { background: true } : {}),
  });
  return joinMinted(job, host, rig, name, cross, ctx, () => {
    const toolCallId = innerToolCallId(job);
    const minted = bot
      ? new BotCallJob({ ...props, toolCallId, botName: trimmed })
      : new AgentCallJob({ ...props, toolCallId });
    job.registerJob(minted);
    return minted;
  });
}

/** `verb` is what the program wrote when that is not the wire name (`mcp/call`). */
function call(ctx: CallCtx, name: string, args: Record<string, unknown>, verb = name): Promise<unknown> {
  const { job, host, rig, tools } = replBag(ctx);
  const cross = crossing(ctx, { kind: "tool", verb, name, args, ...(job.background ? { background: true } : {}) });
  return callTool(job, host, rig, tools, name, args, cross, ctx);
}

export const schemeReplCapability = EnvCapability.define("harness/scheme-repl", {
  /** Arrival s/* tagged lists. Ask lowers them; do not mint a second type wire. */
  deps: [schemaCapability],
  configuration: replConfiguration,
  symbols: (symbol, sz) => ({
    read_file: symbol.native`read_file: read a UTF-8 text file under the project root`(
      {
        input: [sz.string],
        inputRest: { offset: sz.integer.optional(), limit: sz.integer.optional() },
        output: [sz.string],
        provenance: "source",
        requiresConfig: ["host"],
      },
      async function (path, ...rest: unknown[]) {
        invariant(path !== undefined, "read_file: path is required");
        const pathText = stringOf(path);
        // native contour does not fold record rest into a kwargs object.
        const raw = await call(this, "read_file", argsOf({ path: pathText, ...restKwargs(rest, "read_file") }));
        return stampFilePath(new AString(typeof raw === "string" ? raw : String(raw ?? "")), pathText);
      },
    ),

    [UPDATE_METADATA_TOOL_NAME]:
      symbol.rosetta`update_metadata: record this turn's session-list title and an optional description`(
        {
          input: [],
          inputRest: sz.dynamic,
          output: [sz.dynamic],
          provenance: "source",
          requiresConfig: ["host"],
        },
        function (...slots: unknown[]) {
          return call(this, UPDATE_METADATA_TOOL_NAME, metadataArgs(slots));
        },
      ),

    list_dir: symbol.rosetta`list_dir: list a directory under the project root`(
      {
        input: [sz.string],
        inputRest: sz.dynamic,
        output: [sz.list(sz.string)],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (path, ...rest: unknown[]) {
        const { depth } = keywordsOf("list_dir", rest, { depth: sz.integer.optional() });
        return call(this, "list_dir", argsOf({ path, depth })) as Promise<string[]>;
      },
    ),

    grep: symbol.rosetta`grep: search file contents under the project root`(
      {
        input: [sz.string],
        inputRest: sz.dynamic,
        output: [sz.list(sz.string)],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (pattern, ...rest: unknown[]) {
        const kwargs = keywordsOf("grep", rest, {
          path: sz.string.optional(),
          glob: sz.string.optional(),
          mode: sz.string.optional(),
          limit: sz.integer.optional(),
          before: sz.integer.optional(),
          after: sz.integer.optional(),
        });
        return call(this, "grep", argsOf({ pattern, ...kwargs })) as Promise<string[]>;
      },
    ),

    glob: symbol.rosetta`glob: find paths under the project root matching a glob`(
      {
        input: [
          sz.string,
          sz.dict({ cwd: sz.string.optional(), path: sz.string.optional(), limit: sz.integer.optional() }).optional(),
        ],
        output: [sz.list(sz.string)],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (pattern, opts) {
        return call(this, "glob", argsOf({ pattern, ...opts })) as Promise<string[]>;
      },
    ),

    fff_search: symbol.alias`glob`,

    write_file: symbol.rosetta`write_file: create a file, or replace one with overwriteExisting`(
      {
        input: [sz.string, sz.string],
        inputRest: sz.dynamic,
        output: [sz.string],
        provenance: "source",
        queries: (path: string) => fsPath(path),
        effects: (path: string) => fsPath(path),
        requiresConfig: ["host", "writable"],
      },
      function (path, content, ...rest: unknown[]) {
        const { overwriteExisting } = keywordsOf("write_file", rest, {
          overwriteExisting: sz.boolean.optional(),
        });
        return call(this, "write_file", argsOf({ path, content, overwriteExisting })) as Promise<string>;
      },
    ),

    edit_file: symbol.rosetta`edit_file: replace an exact stretch of text in a file`(
      {
        input: [sz.string, sz.string, sz.string],
        inputRest: sz.dynamic,
        output: [sz.string],
        provenance: "source",
        queries: (path: string) => fsPath(path),
        effects: (path: string) => fsPath(path),
        requiresConfig: ["host", "writable"],
      },
      function (path, old_string, new_string, ...rest: unknown[]) {
        const { replace_all } = keywordsOf("edit_file", rest, { replace_all: sz.boolean.optional() });
        return call(this, "edit_file", argsOf({ path, old_string, new_string, replace_all })) as Promise<string>;
      },
    ),

    [SHELL_TOOL_NAME]: symbol.rosetta`shell: run a command in the project workspace`(
      {
        input: [sz.string],
        inputRest: sz.dynamic,
        output: [sz.box],
        provenance: "source",
        queries: (_command: string, ...rest: unknown[]) => [["shell", shellCwd(rest)]],
        effects: (_command: string, ...rest: unknown[]) => [["shell", shellCwd(rest)]],
        requiresConfig: ["host"],
      },
      function (command, ...rest: unknown[]) {
        const kwargs = keywordsOf(SHELL_TOOL_NAME, rest, {
          cwd: sz.string.optional(),
          timeoutMs: sz.integer.optional(),
        });
        return call(this, SHELL_TOOL_NAME, argsOf({ command, ...kwargs })) as Promise<object>;
      },
    ),

    [WEB_SEARCH_TOOL_NAME]: symbol.rosetta`web_search: search the public web`(
      {
        input: [sz.string],
        inputRest: sz.dynamic,
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (query, ...rest: unknown[]) {
        const { numResults } = keywordsOf(WEB_SEARCH_TOOL_NAME, rest, { numResults: sz.integer.optional() });
        return call(this, WEB_SEARCH_TOOL_NAME, argsOf({ query, numResults }));
      },
    ),

    [WEB_EXTRACT_TOOL_NAME]: symbol.rosetta`web_extract: fetch a public URL as markdown`(
      {
        input: [sz.string],
        inputRest: sz.dynamic,
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (url, ...rest: unknown[]) {
        const { charLimit } = keywordsOf(WEB_EXTRACT_TOOL_NAME, rest, { charLimit: sz.integer.optional() });
        return call(this, WEB_EXTRACT_TOOL_NAME, argsOf({ url, charLimit }));
      },
    ),

    "mcp/call": symbol.rosetta`mcp/call: invoke a live MCP tool; connection and tool are data`(
      {
        input: [sz.foldName, sz.foldName],
        inputRest: sz.dynamic,
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (connection: string, tool: string, ...rest: unknown[]) {
        const { host, tools } = replBag(this);
        const args = restKwargs(rest, "mcp/call");
        if (host.replayOnly === true) return call(this, "mcp/call", args, "mcp/call");
        return call(this, resolveToolName(host, tools, connection, tool), args, "mcp/call");
      },
    ),

    "bot/send": symbol.rosetta`bot/send: wait for a standing bot to respond or finish without a response`(
      {
        input: [sz.foldName, sz.string],
        output: [sz.string],
        provenance: "source",
        queries: (spec: string) => [["agent", spec]],
        requiresConfig: ["host"],
      },
      function (spec: string, message: string) {
        return spawnCall(this, AGENT_SEND, true, spec, message, { verb: "bot/send" }) as Promise<string>;
      },
    ),

    "bot/ask": symbol.rosetta`bot/ask: wait for a standing bot's response; finishing without a response is an error`(
      {
        input: [sz.dynamic],
        inputRest: sz.dynamic,
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (...slots) {
        if (isKeyword(slots[0])) throw new Error("bot/ask: a message comes before keywords");
        const { positionals, keywords } = splitKeywords("bot/ask", slots, { readonly: sz.boolean.optional() });
        if (positionals.length > 3) throw new Error("bot/ask: at most spec, message, and schema before keywords");
        const [specSlot, messageSlot, schemaSlot] = positionals;
        const { readonly } = keywords;
        const hasSpec = schemaSlot !== undefined || isStringLike(messageSlot);
        const spec = hasSpec ? stringOf(specSlot) : undefined;
        const message = stringOf(hasSpec ? messageSlot : specSlot);
        const schema = hasSpec ? schemaSlot : messageSlot;
        return spawnCall(this, AGENT_ASK, true, spec, message, {
          verb: "bot/ask",
          deskReadonly: readonly === true,
          schema: compiledAskSchema(schema),
        });
      },
    ),

    "agent/call":
      symbol.rosetta`agent/call: create a disposable worker and wait for it to finish, with or without a response`(
        {
          input: [sz.dynamic, sz.string],
          inputRest: sz.dynamic,
          output: [sz.string],
          provenance: "source",
          requiresConfig: ["host"],
        },
        function (slot, message, ...rest) {
          const spec = workerSpec("agent/call", slot);
          const { model } = keywordsOf("agent/call", rest, { model: sz.string.optional() });
          return spawnCall(this, AGENT_SEND, false, spec, stringOf(message), {
            verb: "agent/call",
            model,
          }) as Promise<string>;
        },
      ),

    "agent/ask": symbol.rosetta`agent/ask: create a disposable worker and wait for its required response`(
      {
        input: [sz.dynamic, sz.string],
        inputRest: sz.dynamic,
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (slot, message, ...rest) {
        const spec = workerSpec("agent/ask", slot);
        const { positionals, keywords } = splitKeywords("agent/ask", rest, {
          readonly: sz.boolean.optional(),
          model: sz.string.optional(),
        });
        if (positionals.length > 1) throw new Error("agent/ask: at most a schema after the message");
        const schemaSlot = positionals[0];
        const { readonly, model } = keywords;
        return spawnCall(this, AGENT_ASK, false, spec, stringOf(message), {
          verb: "agent/ask",
          deskReadonly: readonly === true,
          schema: compiledAskSchema(schemaSlot),
          model,
        });
      },
    ),

    "connection/models": symbol.rosetta`connection/models: live model ids on a completion connection`(
      {
        input: [sz.foldName],
        output: [sz.list(sz.string)],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (connection: string) {
        const { job, host } = replBag(this);
        const emission = this.runCtx.emission;
        if (job.trackMatch && emission != null) {
          const path = claimCrossing(emission, crossingWindow(this));
          const recorded = job.world[path];
          if (recorded !== undefined) return stringList(recorded);
          if (host.replayOnly === true || isReplaying(emission)) {
            throw new Error("replay: connection/models was not recorded");
          }
          const list = host.connectionModels;
          invariant(list != null, "connection/models: host is not configured");
          const ids = [...list(stringOf(connection))];
          runInAction(() => (job.world[path] = JSON.stringify(ids)));
          return ids;
        }
        const list = host.connectionModels;
        invariant(list != null, "connection/models: host is not configured");
        return [...list(stringOf(connection))];
      },
    ),

    "agent/message": symbol.rosetta`agent/message: deliver a message; does not wait for a reply`(
      {
        input: [sz.foldName, sz.string],
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (target, message) {
        const id = UUID_RE.test(target);
        return call(this, AGENT_MESSAGE, argsOf(id ? { targetId: target, message } : { targetName: target, message }));
      },
    ),

    "agent/respond": symbol.notImplemented`agent/respond: close an open worker call with the agent__respond JSON tool — this Scheme symbol is not invocable`,

    "agent/void": symbol.rosetta`agent/void: complete a worker request without a response message`(
      {
        input: [sz.string],
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (requestId) {
        return call(this, AGENT_VOID, argsOf({ requestId }));
      },
    ),

    "agent/notify": symbol.rosetta`agent/notify: send an update without completing the worker request`(
      {
        input: [sz.string, sz.string],
        output: [sz.dynamic],
        provenance: "source",
        requiresConfig: ["host"],
      },
      function (requestId, message) {
        return call(this, AGENT_NOTIFY, argsOf({ requestId, message }));
      },
    ),

    "self/notify":
      symbol.rosetta`self/notify: send an update from this program or worker request without completing it`(
        {
          input: [sz.string],
          output: [sz.undefinedResult],
          provenance: "source",
          requiresConfig: ["host"],
        },
        function (message) {
          const { job, host } = replBag(this);
          if (host.replayOnly === true) return undefined;
          appendNotify(job, host, stringOf(message));
          return undefined;
        },
      ),
  }),
});

function extraToolNames(tools: ReadonlyMap<string, BoundTool>): string[] {
  const skip = new Set<string>([UPDATE_METADATA_TOOL_NAME]);
  const own = schemeReplCapability.spec.symbols;
  if (own != null && typeof own !== "function") for (const name of Object.keys(own)) skip.add(name);
  const schemaSymbols = schemaCapability.spec.symbols;
  if (schemaSymbols != null && typeof schemaSymbols !== "function") {
    for (const name of Object.keys(schemaSymbols)) skip.add(name);
  }
  const names: string[] = [];
  for (const name of tools.keys()) if (!skip.has(name)) names.push(name);
  return names;
}

function deskTools(host: SchemeReplHost): ReadonlyMap<string, BoundTool> {
  if (host.replayTools != null) return host.replayTools;
  const catalog = host.catalog;
  invariant(catalog != null, "scheme-repl: catalog is not configured");
  return boundToolsOf(catalog, { readonly: host.readonly === true });
}

/** Pack tools bind as their own symbols for this eval. MCP stays on mcp/call. */
function packToolCapability(tools: ReadonlyMap<string, BoundTool>): EnvCapability | undefined {
  const names = extraToolNames(tools);
  if (names.length === 0) return undefined;
  return EnvCapability.define("harness/scheme-repl-pack", {
    configuration: replConfiguration,
    symbols: (symbol, sz) => {
      const jsonDict = sz.dictRecord(sz.foldName, sz.dynamic).optional();
      const verbs: Record<string, SymbolDeclaration> = {};
      for (const name of names) {
        verbs[name] = symbol.rosetta`${name}: pack tool`(
          {
            input: [jsonDict],
            output: [sz.dynamic],
            provenance: "source",
            requiresConfig: ["host"],
          },
          function (args?: Record<string, unknown>) {
            return call(this, name, jsRecord(args));
          },
        );
      }
      return verbs;
    },
  });
}

function vocabulary(
  host: SchemeReplHost,
  moduleRoot: string | undefined,
  job: ProgrammaticJob,
): {
  readonly capabilities: readonly EnvCapability[];
  readonly config: object;
} {
  const tools = deskTools(host);
  const pack = packToolCapability(tools);
  if (host.replayOnly !== true) {
    const names = extraToolNames(tools);
    runInAction(() => {
      job.trackMatch = true;
      for (const name of names) job.boundTools[name] = "";
    });
  }
  const loader =
    moduleRoot == null
      ? undefined
      : host.replayOnly === true || host.loadSource == null
        ? recordedModuleLoader(job)
        : host.loadSource(moduleRoot, job);
  return {
    capabilities: [
      schemeReplCapability,
      ...(pack == null ? [] : [pack]),
      ...(moduleRoot == null ? [] : [arrivalYamlCapability, promptProgramCapability, schemeLoadAliasCapability]),
    ],
    config: {
      ...(host.readonly === true ? {} : { writable: true }),
      host,
      tools,
      ...(host.keyOf === undefined ? {} : { keyOf: host.keyOf }),
      ...(loader == null
        ? {}
        : {
            loader,
            dirname: "",
            connectionId: host.connectionId,
            completionModel: host.completionModel,
            complete: host.complete,
            readonly: host.readonly === true,
          }),
    },
  };
}

/** Identity is the host object, so a park remint still compares SchemeReplHost identity. */
export function programHostOf(host: SchemeReplHost): ProgramHost {
  return {
    identity: host,
    signal: host.signal,
    doors: host.doors,
    root: host.root,
    abort: host.abort,
    notify: host.notify,
    evalProgram: host.evalProgram,
    moduleRoot: host.moduleRoot,
    observe: host.observe,
    replayOnly: host.replayOnly,
    tools: () => deskTools(host),

    prepare(opts) {
      return vocabulary(host, opts.moduleRoot, opts.job);
    },
  };
}

export function replRuntimeOf(job: ProgrammaticJob, host: SchemeReplHost): ReplRuntime {
  return programRuntimeOf(job, programHostOf(host));
}

/** R7RS `load` is a host door. Last-write-wins over it; expands to `require`. */
export const schemeLoadAliasCapability = EnvCapability.define("harness/scheme-repl-load", {
  deps: [arrivalLoaderCapability],
  symbols: (symbol) => ({
    load: symbol.defineSyntax`load: alias of require; spills .scm defines into this run`(
      "(lambda (specifier) `(require ,specifier))",
    ),
  }),
});
