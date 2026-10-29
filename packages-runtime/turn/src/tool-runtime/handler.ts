/**
 * Project-bound mint of one model tool_call. Does not execute.
 * Connection-sourced names are MCPToolJob; write_file / edit_file are
 * FileMutateToolJob; pack / unknown are SystemToolJob.
 * `agentCallFromWire` mints `agent__ask` / `agent__send`. `admit` wraps it; the turn calls it directly.
 * Both append onto `AdmitContext.parent` when the caller passes one. They do not enqueue.
 * Bot-call pack tools and standing bot invocations mint BotCallJob.
 * `scheme_repl` is a ProgrammaticJob bag. Inner admits reuse this door.
 */
import { createHash } from "node:crypto";

import {
  AgentCallJob,
  BotCallJob,
  CallJob,
  AgentCallbackJob,
  AgentMessageJob,
  AgentNotifyJob,
  AGENT_ASK,
  AGENT_MESSAGE,
  AGENT_NOTIFY,
  AGENT_RESPOND,
  AGENT_SEND,
  AGENT_VOID,
  CallDelivery,
  CONTEXT_NEED_TOOL_NAME,
  ContextNeedToolJob,
  FailureOutcome,
  FileMutateToolJob,
  MCPToolJob,
  McpToolExpectation,
  mcpToolListHas,
  parseWebExtractArgs,
  parseWebSearchArgs,
  ProgrammaticJob,
  SCHEME_REPL_TOOL_NAME,
  SCHEME_WATCH_TOOL_NAME,
  SessionRoot,
  SessionTurn,
  storageIncludingOffTape,
  SystemToolJob,
  ToolCallJob,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WebExtractExpectation,
  WebExtractToolJob,
  WebSearchExpectation,
  WebSearchToolJob,
  writePluginMeta,
} from "@inhuman.tools/harness-model";
import { parseJsonRecord } from "@inhuman.tools/harness-model/json-record";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";

import { externalizePrior } from "./blob-port.js";
import { peelAgentCallArgs, requestIdOf } from "./peel.js";
import { workerToolAllowed } from "./worker-tools.js";
import { lineStartOfSpan, writeFileAdmitSnap } from "./write-admit.js";
import { policyOfTurn, stampJobRetention } from "../context/retention/index.js";
import { peelShellCwd } from "../policy-processor/peel-cwd.js";
import { agentCallSupportsNotify, type CatalogEntry, type KernelToolCatalog } from "../tool-catalog/index.js";

/** Catalog face the handler proxies to. A kernel host satisfies this. */
export type ToolCallKernel = {
  readonly catalog: KernelToolCatalog;
};

export type AdmitContext = {
  readonly session?: SessionRoot;
  readonly originTurn?: SessionTurn;
  readonly loadAgentCall?: (uuid: string) => CallJob | undefined;
  /**
   * Receives the job before admit returns. A reachable child can start, so pass
   * this only for a call that may start.
   */
  readonly parent?: { registerJob(child: AdmittedCall): void };
};

type CatalogWithInstall = KernelToolCatalog & {
  readonly pluginInstall?: {
    readonly plugins: ReadonlyMap<string, { readonly definition: unknown }>;
  };
};

function pluginRevision(catalog: KernelToolCatalog, pluginName: string): string {
  const record = (catalog as CatalogWithInstall).pluginInstall?.plugins.get(pluginName);
  if (record == null) return "";
  return createHash("sha256").update(JSON.stringify(record.definition)).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stamp(argsJson: string): { background?: true; walkBoundary?: true } {
  const parsed = parseJsonRecord(argsJson === "" ? "{}" : argsJson);
  if (parsed != null && parsed.background === true) {
    return { background: true, walkBoundary: true };
  }
  return {};
}

/** The prior text as job props: inline while small, a blob reference once it passes the inline limit. */
function priorProps(text: string | null): { readonly priorContent?: string; readonly priorBlobJson?: string } {
  return text === null ? {} : externalizePrior(text);
}

function catalogFlags(entry: CatalogEntry | undefined): {
  readonly triggersReactLoop: boolean;
  readonly tapeHidden: boolean;
  readonly isSideChannel: boolean;
} {
  return {
    triggersReactLoop: entry?.triggersReactLoop ?? true,
    tapeHidden: entry?.tapeHidden ?? false,
    isSideChannel: entry?.isSideChannel === true,
  };
}

function sealedValidateDoor(toolCallId: string, argsJson: string, text: string, entry?: CatalogEntry): ProgrammaticJob {
  return new ProgrammaticJob({
    toolCallId,
    argsJson,
    completed: true,
    outcomeJson: JSON.stringify({ ok: false, text }),
    ...catalogFlags(entry),
  });
}

function admitExam(call: ToolCall, ctx: AdmitContext, entry: CatalogEntry): ProgrammaticJob {
  const toolCallId = call.id;
  const argsJson = call.function.arguments;
  const exam = entry.exam;
  if (exam == null) return sealedValidateDoor(toolCallId, argsJson, "exam admit missing", entry);
  if (ctx.session == null) {
    return sealedValidateDoor(toolCallId, argsJson, `${call.function.name}: missing session`, entry);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson === "" ? "{}" : argsJson);
  } catch {
    return sealedValidateDoor(toolCallId, argsJson, `${call.function.name}: arguments were not valid JSON`, entry);
  }
  const input = asRecord(raw);
  if (input == null) {
    return sealedValidateDoor(toolCallId, argsJson, `${call.function.name}: arguments must be a JSON object`, entry);
  }
  const pluginId = entry.source.kind === "pack" ? entry.source.pluginName : "";
  const storage = ctx.originTurn == null ? ctx.session.storageAfter : storageIncludingOffTape(ctx.originTurn);
  const prefix = pluginId === "" ? {} : (storage[pluginId] ?? {});
  const program = exam.program(prefix, input);
  if (typeof program !== "string") {
    return sealedValidateDoor(toolCallId, argsJson, program.error, entry);
  }
  // The exam bag is executed as a scheme_repl program, so `description` is
  // required at the door. The tool name is the honest one-line label — it is
  // also the renderer's fallback when a description is absent.
  const frozen = JSON.stringify({
    ...input,
    expr: program,
    description: call.function.name,
  });
  const bag = new ProgrammaticJob({
    toolCallId,
    toolName: call.function.name,
    argsJson: frozen,
    ...stamp(frozen),
    ...catalogFlags(entry),
  });
  if (bag.background && bag.toolCallId.trim() !== "") {
    bag.outcomeSnap ??= { ok: true, value: { job_id: bag.toolCallId, background: true } };
  }
  ctx.originTurn?.pushChild(bag);
  const action = exam.admit(prefix, input);
  let jobUuid = "";
  try {
    jobUuid = bag.uuid;
  } catch {
    jobUuid = "";
  }
  const actionRec = asRecord(action);
  writePluginMeta(bag, pluginId, actionRec == null ? action : { ...actionRec, jobUuid }, true);
  return bag;
}

function rejectedComms(
  kind: "callback" | "notify",
  toolCallId: string,
  name: string,
  argsJson: string,
  text: string,
): AgentCallbackJob | AgentNotifyJob {
  const props = {
    toolCallId,
    name,
    argsJson,
    regenerateable: false as const,
    humanApprove: false as const,
    outcomeJson: JSON.stringify({ ok: false, text }),
    completed: true,
  };
  return kind === "callback" ? new AgentCallbackJob(props) : new AgentNotifyJob(props);
}

export type AdmittedCall = ToolCallJob | ProgrammaticJob;

function appendJob<T extends AdmittedCall>(ctx: AdmitContext, job: T): T {
  ctx.parent?.registerJob(job);
  return job;
}

function ceilingJob(call: ToolCall): SystemToolJob {
  return new SystemToolJob({
    toolCallId: call.id,
    name: call.function.name,
    argsJson: call.function.arguments,
    humanApprove: false,
    completed: true,
    outcomeJson: JSON.stringify({
      ok: false,
      text: "outside worker tool ceiling",
    }),
  });
}

/** Standing bot or owned child from an `agent__ask` / `agent__send` wire. Unknown recipes seal the ceiling. */
export function agentCallFromWire(
  call: ToolCall,
  catalog: KernelToolCatalog,
  ctx: AdmitContext = {},
): BotCallJob | AgentCallJob | SystemToolJob {
  const name = call.function.name;
  if (ctx.session != null && !workerToolAllowed(catalog, ctx.session.agent.spec.name, name, ctx.session)) {
    return appendJob(ctx, ceilingJob(call));
  }
  const peeled = peelAgentCallArgs(call.function.arguments);
  const spec = parseJsonRecord(peeled.argsJson)?.spec;
  // Select the explicit child or bot node at admission;
  // downstream execution is selected by the resulting class, not oneShot/catalog state.
  if (!peeled.oneShot && typeof spec === "string" && spec.trim() !== "") {
    return appendJob(
      ctx,
      new BotCallJob({
        toolCallId: call.id,
        name,
        argsJson: peeled.argsJson,
        botName: spec.trim(),
        voidLegal: name === AGENT_SEND ? peeled.voidLegal : false,
        readonly: peeled.readonly,
        responseSchema: peeled.responseSchema,
        ...stamp(peeled.argsJson),
      }),
    );
  }
  return appendJob(
    ctx,
    new AgentCallJob({
      toolCallId: call.id,
      name,
      argsJson: peeled.argsJson,
      regenerateable: false,
      voidLegal: name === AGENT_SEND ? peeled.voidLegal : false,
      readonly: peeled.readonly,
      responseSchema: peeled.responseSchema,
      constitution: peeled.constitution,
      faceName: peeled.faceName,
      tools: peeled.tools,
      inheritCallerTools: peeled.inheritCallerTools,
      reasoningEffort: peeled.reasoningEffort,
      ...stamp(peeled.argsJson),
    }),
  );
}

export class ToolCallHandler {
  constructor(readonly kernel: ToolCallKernel) {}

  admit(call: ToolCall, catalog: KernelToolCatalog = this.kernel.catalog, ctx: AdmitContext = {}): AdmittedCall {
    const job = this.#admit(call, catalog, ctx);
    // R2: the horizon is resolved once, here, from the turn's R1 policy and the catalog as it is now.
    const entry = catalog.catalogEntry(call.function.name) ?? this.kernel.catalog.catalogEntry(call.function.name);
    const turn = ctx.originTurn ?? ctx.session?.head ?? null;
    stampJobRetention(job, policyOfTurn(turn instanceof SessionTurn ? turn : null), {
      ...(entry?.class === undefined ? {} : { entryClass: entry.class }),
      ...(entry?.retention === undefined ? {} : { hint: entry.retention }),
    });
    return job;
  }

  #admit(call: ToolCall, catalog: KernelToolCatalog, ctx: AdmitContext): AdmittedCall {
    const place = <T extends AdmittedCall>(job: T): T => appendJob(ctx, job);
    const toolCallId = call.id;
    const name = call.function.name;
    const argsJson = call.function.arguments;
    if (ctx.session != null && !workerToolAllowed(catalog, ctx.session.agent.spec.name, name, ctx.session)) {
      return place(ceilingJob(call));
    }
    if (name === SCHEME_REPL_TOOL_NAME || name === SCHEME_WATCH_TOOL_NAME) {
      const flagged =
        name === SCHEME_WATCH_TOOL_NAME ? { background: true as const, walkBoundary: true as const } : stamp(argsJson);
      const job = new ProgrammaticJob({
        toolName: name,
        toolCallId,
        argsJson,
        ...flagged,
      });
      if (job.background && job.toolCallId.trim() !== "") {
        job.outcomeSnap ??= { ok: true, value: { job_id: job.toolCallId, background: true } };
      }
      return place(job);
    }
    const viewEntry = catalog.catalogEntry(name);
    const kernelEntry = this.kernel.catalog.catalogEntry(name);
    const entry = viewEntry ?? kernelEntry ?? catalog.privateWorkerEntries.find((row) => row.wireName === name);
    const regenerateable = viewEntry?.class === "read";
    if (entry?.exam != null) {
      return place(admitExam(call, ctx, entry));
    }
    if (entry?.packMeta?.kind === "bot-call") {
      const meta = entry.packMeta;
      const recipe = catalog.recipe(meta.target);
      const known = recipe != null;
      const revision = pluginRevision(catalog, meta.pluginName);
      const peeled = peelAgentCallArgs(argsJson);
      const job = new BotCallJob({
        toolCallId,
        name,
        argsJson: peeled.argsJson,
        botName: meta.target,
        regenerateable: false,
        voidLegal: peeled.voidLegal,
        readonly: peeled.readonly,
        responseSchema: peeled.responseSchema,
        contributionPluginName: meta.pluginName,
        contributionBotName: meta.target,
        contributionRevision: revision,
        ...(meta.background ? { background: true, walkBoundary: true } : stamp(argsJson)),
        ...(known
          ? {}
          : {
              outcome: new FailureOutcome({
                code: "unknown_recipe",
                message: "unknown recipe",
              }),
              completed: true,
            }),
      });
      if (known && meta.lifetime != null) job.delivery = new CallDelivery({ lifetime: meta.lifetime });
      return place(job);
    }
    if (entry?.source.kind === "connection") {
      const hidden = viewEntry == null && !catalog.privateWorkerEntries.some((row) => row.wireName === name);
      const blocked =
        ctx.session != null &&
        mcpToolListHas(ctx.session.toolBlocklist, entry.source.connectionKey, entry.source.serverToolName);
      if (hidden || blocked) {
        return place(
          new MCPToolJob({
            toolCallId,
            name,
            argsJson,
            regenerateable: false,
            connectionKey: entry.source.connectionKey,
            serverToolName: entry.source.serverToolName,
            expectation: new McpToolExpectation({
              connectionId: entry.source.connectionKey,
              serverToolName: entry.source.serverToolName,
              argsJson,
            }),
            humanApprove: false,
            completed: true,
            outcomeJson: JSON.stringify({
              ok: false,
              text: `unknown MCP tool "${entry.source.serverToolName}"`,
            }),
          }),
        );
      }
      return place(
        new MCPToolJob({
          toolCallId,
          name,
          argsJson,
          regenerateable,
          connectionKey: entry.source.connectionKey,
          serverToolName: entry.source.serverToolName,
          expectation: new McpToolExpectation({
            connectionId: entry.source.connectionKey,
            serverToolName: entry.source.serverToolName,
            argsJson,
          }),
        }),
      );
    }
    if (name === AGENT_ASK || name === AGENT_SEND) {
      return agentCallFromWire(call, catalog, ctx);
    }
    const requestId = requestIdOf(argsJson);
    const ownsOpen = ctx.session != null && requestId !== "" && ctx.session.agentCallbacks[requestId] != null;
    if (name === AGENT_RESPOND || name === AGENT_VOID) {
      if (ownsOpen) {
        return place(
          new AgentCallbackJob({
            toolCallId,
            name,
            argsJson,
            regenerateable: false,
            ...stamp(argsJson),
          }),
        );
      }
      return place(rejectedComms("callback", toolCallId, name, argsJson, "no open callback"));
    }
    if (name === AGENT_NOTIFY) {
      const open = ownsOpen && ctx.loadAgentCall != null ? ctx.loadAgentCall(requestId) : undefined;
      if (open != null && agentCallSupportsNotify(catalog, open.name)) {
        return place(
          new AgentNotifyJob({
            toolCallId,
            name,
            argsJson,
            regenerateable: false,
            ...stamp(argsJson),
          }),
        );
      }
      return place(rejectedComms("notify", toolCallId, name, argsJson, "no open notify"));
    }
    if (name === AGENT_MESSAGE) {
      return place(
        new AgentMessageJob({
          toolCallId,
          name,
          argsJson,
          regenerateable: false,
          ...stamp(argsJson),
        }),
      );
    }
    if (name === CONTEXT_NEED_TOOL_NAME) {
      return place(
        new ContextNeedToolJob({
          toolCallId,
          name,
          argsJson,
          regenerateable: false,
          ...stamp(argsJson),
          ...catalogFlags(entry),
        }),
      );
    }
    if (name === WEB_SEARCH_TOOL_NAME) {
      const parsed = parseWebSearchArgs(argsJson);
      return place(
        new WebSearchToolJob({
          toolCallId,
          name,
          argsJson,
          regenerateable: false,
          expectation: new WebSearchExpectation({
            connectionId: WEB_SEARCH_TOOL_NAME,
            query: parsed.query,
            limit: parsed.limit,
          }),
          ...stamp(argsJson),
        }),
      );
    }
    if (name === WEB_EXTRACT_TOOL_NAME) {
      const parsed = parseWebExtractArgs(argsJson);
      return place(
        new WebExtractToolJob({
          toolCallId,
          name,
          argsJson,
          regenerateable: false,
          expectation: new WebExtractExpectation({
            connectionId: WEB_EXTRACT_TOOL_NAME,
            url: parsed.url,
            charLimit: parsed.charLimit,
          }),
          ...stamp(argsJson),
        }),
      );
    }
    const fileRoot = ctx.session?.path.trim() ?? "";
    const fileSnap =
      (name === "write_file" || name === "edit_file") && fileRoot !== ""
        ? writeFileAdmitSnap(fileRoot, argsJson)
        : null;
    let oldString = "";
    if (name === "edit_file") {
      const parsed = parseJsonRecord(argsJson === "" ? "{}" : argsJson);
      const old = parsed == null ? undefined : parsed.old_string;
      if (typeof old === "string") oldString = old;
    }
    const priorLineStart =
      name === "edit_file" && fileSnap?.priorContent != null ? lineStartOfSpan(fileSnap.priorContent, oldString) : null;
    let shellArgsJson = argsJson;
    let shellRefuse: string | undefined;
    if (name === "shell") {
      const parsed = parseJsonRecord(argsJson === "" ? "{}" : argsJson);
      if (parsed != null) {
        const command = parsed.command;
        if (typeof command === "string" && command !== "") {
          const cwdArg = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
          const peeled = peelShellCwd(command, cwdArg);
          if (peeled !== null && peeled.command === "") {
            shellRefuse = "cwd only; use the cwd arg on the next call";
          } else if (peeled !== null) {
            shellArgsJson = JSON.stringify({
              ...parsed,
              cwd: peeled.cwd,
              command: peeled.command,
            });
          }
        }
      }
    }
    if (shellRefuse !== undefined) {
      return place(
        new SystemToolJob({
          toolCallId,
          name,
          argsJson: shellArgsJson,
          regenerateable: false,
          completed: true,
          outcomeJson: JSON.stringify({ ok: false, text: shellRefuse }),
        }),
      );
    }
    if (name === "write_file" || name === "edit_file") {
      if (name === "write_file" && fileSnap?.refuse != null) {
        return place(
          new FileMutateToolJob({
            toolCallId,
            name,
            argsJson,
            regenerateable: false,
            completed: true,
            existed: fileSnap.existed,
            ...priorProps(fileSnap.priorContent),
            outcomeJson: JSON.stringify({ ok: false, text: fileSnap.refuse }),
          }),
        );
      }
      const prior =
        fileSnap == null
          ? {}
          : {
              ...(fileSnap.existed === null ? {} : { existed: fileSnap.existed }),
              ...priorProps(fileSnap.priorContent),
              ...(priorLineStart == null ? {} : { priorLineStart }),
            };
      return place(
        new FileMutateToolJob({
          toolCallId,
          name,
          argsJson,
          regenerateable,
          ...catalogFlags(entry),
          ...prior,
        }),
      );
    }
    return place(
      new SystemToolJob({
        toolCallId,
        name,
        argsJson: shellArgsJson,
        regenerateable,
        ...catalogFlags(entry),
      }),
    );
  }
}
