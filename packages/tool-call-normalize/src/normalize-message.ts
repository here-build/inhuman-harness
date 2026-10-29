import { tryParseFunctionArguments } from "./args-xml.js";
import { coerceArgs, parseJsonArgsBody } from "./coerce.js";
import { argsEqual } from "./dedup.js";
import { ensureBuiltins } from "./dialects/registry.js";
import { maskFences } from "./fence.js";
import { repairFinish } from "./finish.js";
import { mintId } from "./ids.js";
import { assembleEvents } from "./ir.js";
import { applyArgAliases, resolveName } from "./names.js";
import { collectStreamSync } from "./normalize-stream.js";
import { effectiveAliases, resolveDialectId } from "./resolve-dialect.js";
import { isMissingRequired, schemaRepairArgsJson } from "./schema-repair.js";
import { mergeReasoning, splitThink } from "./think.js";
import {
  type Dialect,
  type MessageInput,
  type NormalizeMessageResult,
  type NormalizeMeta,
  type NormalizeOptions,
  type OpenAiChatChunk,
  type RawToolCall,
  type ToolCall,
  NormalizeError,
} from "./types.js";

function emptyMeta(dialect: string): NormalizeMeta {
  return {
    dialect,
    estimated: false,
    toolsInThinkingCount: 0,
    dropped: [],
    ambiguous: [],
    partial: [],
    untypedArgs: false,
    renamed: [],
  };
}

/** Best-effort parse of an arguments JSON string for the required-key gate. */
function parseArgsObject(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* unparseable → treat as empty, no keys present */
  }
  return {};
}

function cleanupContent(text: string, spans: Array<{ start: number; end: number }>): string | null {
  if (spans.length === 0) {
    const t = text.trimEnd();
    return t.length > 0 ? t : null;
  }
  let out = text;
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  for (const s of sorted) {
    const before = out.slice(0, s.start);
    const after = out.slice(s.end);
    out = before.replace(/\n{3,}$/, "\n\n") + after.replace(/^\n{3,}/, "\n\n");
  }
  out = out.trimEnd();
  return out.length > 0 ? out : null;
}

/**
 * Rename arg keys on a parsed object. Type-preserving: never stringify/reparse
 * values (audit-010 C4 — MCP JSON body strings must stay strings through alias).
 */
function applyArgAliasesToObject(
  name: string,
  orig: Record<string, unknown>,
  argAliases: Record<string, Record<string, string>>,
): Record<string, unknown> {
  if (!argAliases || Object.keys(argAliases).length === 0) return orig;
  const specific = argAliases[name] ?? {};
  const star = argAliases["*"] ?? {};
  const map = { ...star, ...specific };
  if (Object.keys(map).length === 0) return orig;
  const out: Record<string, unknown> = { ...orig };
  for (const [from, to] of Object.entries(map)) {
    if (from in out && !(to in out)) {
      out[to] = out[from];
      delete out[from];
    }
    // if target exists, leave source unrenamed (keep both)
  }
  return out;
}

function applyArgAliasesToJson(
  name: string,
  argsJson: string,
  argAliases: Record<string, Record<string, string>>,
): string {
  if (!argAliases || Object.keys(argAliases).length === 0) return argsJson;
  try {
    const obj = JSON.parse(argsJson) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return argsJson;
    const next = applyArgAliasesToObject(name, obj as Record<string, unknown>, argAliases);
    return JSON.stringify(next);
  } catch {
    return argsJson;
  }
}

function processRawCalls(
  raws: RawToolCall[],
  opts: {
    mode: "repair" | "strict";
    tools?: NormalizeOptions["tools"];
    nameAliases: Record<string, string>;
    argAliases: Record<string, Record<string, string>>;
    idStyle: NormalizeOptions["idStyle"];
    requireKnownTool?: boolean;
    /** Indices into `raws` that are truncated. */
    truncated?: number[];
  },
  meta: NormalizeMeta,
): { calls: ToolCall[]; partialLocal: number[] } {
  const out: ToolCall[] = [];
  const partialLocal: number[] = [];
  const truncSet = new Set(opts.truncated);
  const nameOpts = {
    tools: opts.tools,
    nameAliases: opts.nameAliases,
    mode: opts.mode,
    requireKnownTool: opts.requireKnownTool,
    recovered: true as const,
  };
  for (const [ri, raw_] of raws.entries()) {
    const raw = raw_!;
    let name = "";
    let argsJson = "{}";

    if (raw.form === "json") {
      const parsed = parseJsonArgsBody(raw.bodyJson);
      if (!parsed) {
        meta.dropped.push({ name: "", reason: "unparseable_args" });
        continue;
      }
      name = parsed.name;
      argsJson = parsed.arguments || "{}";

      const resolved = resolveName(name, nameOpts);
      if (resolved.ok) {
        if (resolved.renamedFrom) {
          meta.renamed.push({ from: resolved.renamedFrom, to: resolved.name });
        }
        name = resolved.name;
      } else {
        if (resolved.keepAsRaw) {
          meta.ambiguous.push({
            name: resolved.name,
            candidates: resolved.ambiguousCandidates ?? [],
          });
          name = resolved.name;
        } else {
          meta.dropped.push({ name: resolved.name, reason: resolved.reason });
          continue;
        }
      }
      argsJson = applyArgAliasesToJson(name, argsJson, opts.argAliases);
      argsJson = schemaRepairArgsJson(name, argsJson, opts.tools);
    } else {
      name = raw.rawName;
      const pre = resolveName(name, nameOpts);
      const toolForAlias = pre.ok ? pre.name : name;
      const aliased2 = applyArgAliases(toolForAlias, raw.argsTagged, opts.argAliases);
      const coerced = coerceArgs(toolForAlias, aliased2, opts.tools);
      argsJson = coerced.json;
      if (coerced.untyped) meta.untypedArgs = true;
      if (pre.ok && pre.renamedFrom) {
        meta.renamed.push({ from: pre.renamedFrom, to: pre.name });
        name = pre.name;
      } else if (pre.ok) {
        name = pre.name;
      } else {
        if (pre.keepAsRaw) {
          meta.ambiguous.push({
            name: pre.name,
            candidates: pre.ambiguousCandidates ?? [],
          });
          name = pre.name;
        } else {
          meta.dropped.push({ name: pre.name, reason: pre.reason });
          continue;
        }
      }
      argsJson = schemaRepairArgsJson(name, argsJson, opts.tools);
    }

    if (!argsJson || argsJson === "") argsJson = "{}";
    const id = mintId(out.length, name, argsJson, opts.idStyle, false);
    if (truncSet.has(ri)) partialLocal.push(out.length);
    out.push({
      id,
      type: "function",
      function: { name, arguments: argsJson },
    });
  }
  return { calls: out, partialLocal };
}

function normalizeNativeArgs(
  tc: ToolCall,
  name: string,
  argAliases: Record<string, Record<string, string>>,
  tools?: NormalizeOptions["tools"],
): ToolCall {
  let args = tc.function.arguments ?? "{}";
  // Continue #11453: arguments may be XML when JSON parse would fail
  const xmlOrJson = tryParseFunctionArguments(args);
  if (xmlOrJson.ok) args = xmlOrJson.arguments;
  if (argAliases && Object.keys(argAliases).length > 0) {
    args = applyArgAliasesToJson(name, args, argAliases);
  }
  args = schemaRepairArgsJson(name, args, tools);
  if (args === tc.function.arguments && name === tc.function.name) {
    return tc;
  }
  return {
    ...tc,
    function: { ...tc.function, name, arguments: args },
  };
}

function resolveNativeNames(
  natives: ToolCall[],
  opts: {
    mode: "repair" | "strict";
    tools?: NormalizeOptions["tools"];
    nameAliases: Record<string, string>;
    argAliases: Record<string, Record<string, string>>;
  },
  meta: NormalizeMeta,
): ToolCall[] {
  const strictDrops = new Set<number>();
  const mapped = natives.map((tc, i) => {
    const resolved = resolveName(tc.function.name, {
      tools: opts.tools,
      nameAliases: opts.nameAliases,
      mode: opts.mode,
      recovered: false,
    });
    if (!resolved.ok) {
      if (resolved.keepAsRaw) {
        meta.ambiguous.push({
          name: resolved.name,
          candidates: resolved.ambiguousCandidates ?? [],
        });
        return normalizeNativeArgs(tc, tc.function.name, opts.argAliases, opts.tools);
      }
      if (opts.mode === "strict") {
        meta.dropped.push({ name: resolved.name, reason: resolved.reason });
        strictDrops.add(i);
      }
      return tc;
    }
    if (resolved.renamedFrom) {
      meta.renamed.push({ from: resolved.renamedFrom, to: resolved.name });
    }
    return normalizeNativeArgs(tc, resolved.name, opts.argAliases, opts.tools);
  });
  if (opts.mode !== "strict") return mapped;
  return mapped.filter((_, i) => !strictDrops.has(i));
}

/**
 * Soft modelHint (audit-004 H2 … audit-007 F2 option c):
 * - Forced dialect is hard.
 * - Markerless dialect (openai) never falls through — prose examples stay inert.
 * - Unimplemented hint (no registered dialect) falls through to auto so real
 *   markup still recovers (F2).
 * - Registered marker dialect that extracts nothing falls through to auto only
 *   when auto finds a *different* dialect (template mismatch recovery).
 */
function resolveDialectSoft(masked: string, opts: NormalizeOptions): { dialect: Dialect | null; id: string } {
  if (opts.dialect && opts.dialect !== "auto") {
    return resolveDialectId(masked, opts);
  }
  const withHint = resolveDialectId(masked, opts);
  if (!opts.modelHint) return withHint;
  if (!withHint.dialect) return withHint; // unimplemented or none
  if (withHint.dialect.markers.length === 0) return withHint;
  const ex = withHint.dialect.extract(masked, {});
  if (ex.raw_calls.length === 0 && ex.toolSpans.length === 0) {
    const auto = resolveDialectId(masked, { dialect: "auto" });
    if (auto.dialect && auto.id !== withHint.id) return auto;
  }
  return withHint;
}

/** Merge natives + recovered, remapping recovered-local partial indices. */
function mergeWithPartial(
  natives: ToolCall[],
  recovered: ToolCall[],
  recoveredPartialLocal: number[],
): { tool_calls: ToolCall[]; partial: number[] } {
  const used = new Set<number>();
  const out: ToolCall[] = [...natives];
  const partial: number[] = [];
  const partialSet = new Set(recoveredPartialLocal);
  for (const [ri, element] of recovered.entries()) {
    const r = element!;
    let matched = false;
    for (const [i, native] of natives.entries()) {
      if (used.has(i)) continue;
      const n = native!;
      if (n.function.name === r.function.name && argsEqual(n.function.arguments, r.function.arguments)) {
        used.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (partialSet.has(ri)) partial.push(out.length);
      out.push(r);
    }
  }
  return { tool_calls: out, partial };
}

/**
 * Whether batch tools+finish may be defined as assemble(single-chunk stream).
 * Forced dialect + repair/strict; rescan is batch-only on the stream path.
 */
function canAssembleBatch(opts: NormalizeOptions): boolean {
  const mode = opts.mode ?? "repair";
  if (mode !== "repair" && mode !== "strict") return false;
  if (!opts.dialect || opts.dialect === "auto") return false;
  if ((opts.nativePolicy ?? "merge") === "rescan") return false;
  return true;
}

/** Build stream chunks that preserve content + native tool_calls + reasoning. */
function messageToStreamChunks(input: MessageInput, opts: NormalizeOptions): Array<string | OpenAiChatChunk> {
  if (typeof input === "string") {
    const chunks: Array<string | OpenAiChatChunk> = [input];
    if (opts.finishReasonIn) {
      chunks.push({
        choices: [{ delta: {}, finish_reason: opts.finishReasonIn }],
      });
    }
    return chunks;
  }
  const content = input.content ?? "";
  const natives = input.tool_calls ?? [];
  const reasoning = input.reasoning_content ?? null;
  const chunks: Array<string | OpenAiChatChunk> = [];

  if (natives.length > 0 || reasoning) {
    chunks.push({
      choices: [
        {
          delta: {
            content: content || undefined,
            reasoning_content: reasoning || undefined,
            tool_calls:
              natives.length > 0
                ? natives.map((t, i) => ({
                    index: i,
                    id: t.id,
                    function: {
                      name: t.function.name,
                      arguments: t.function.arguments ?? "{}",
                    },
                  }))
                : undefined,
          },
        },
      ],
    });
  } else {
    chunks.push(content);
  }
  chunks.push({
    choices: [
      {
        delta: {},
        finish_reason: opts.finishReasonIn ?? "stop",
      },
    ],
  });
  return chunks;
}

/** Name + parsed-args multiset equality (order/ids ignored). */
function toolsNameArgsEqual(a: ToolCall[], b: ToolCall[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: ToolCall) => {
    let args = t.function.arguments || "{}";
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {
      /* keep raw */
    }
    return `${t.function.name}\0${args}`;
  };
  const ca = a.map(key).sort();
  const cb = b.map(key).sort();
  return ca.every((k, i) => k === cb[i]);
}

/**
 * Fold path (§9.7): tools+finish defined relative to
 * assembleEvents(collectStreamSync(singleChunk)).
 *
 * Dual-path honesty:
 * - When assemble tool multiset (name+args) matches the extract engine: finish_reason
 *   comes from the assemble (by construction); tool_calls/meta/content from extract
 *   (native ids, merge order, fence law, cleanupContent seams).
 * - When they diverge (fence-in-arg premature close residual, live id order):
 *   public API keeps extract engine entirely — documented remaining gaps.
 */
function normalizeMessageViaAssemble(input: MessageInput, opts: NormalizeOptions): NormalizeMessageResult {
  const core = normalizeMessageImpl(input, opts);
  let assembled: NormalizeMessageResult;
  try {
    const events = collectStreamSync(messageToStreamChunks(input, opts), opts);
    assembled = assembleEvents(events, { dropPartials: false });
    for (const pi of assembled.meta.partial) {
      const t = assembled.tool_calls[pi];
      if (!t) continue;
      assembled.tool_calls[pi] = {
        ...t,
        function: { ...t.function, arguments: "{}" },
      };
    }
  } catch {
    return core;
  }

  if (!toolsNameArgsEqual(core.tool_calls, assembled.tool_calls)) {
    return core;
  }

  return {
    content: core.content,
    reasoning_content: core.reasoning_content,
    // Tools multiset ≡ assemble; extract engine preserves native ids + merge order
    tool_calls: core.tool_calls,
    finish_reason: assembled.finish_reason,
    meta: core.meta,
  };
}

/**
 * Public batch API.
 *
 * Under repair/strict + forced dialect (not rescan): tools + finish_reason
 * are defined as assemble(single-chunk stream) — §9.7 by construction.
 * Content remains the extract-engine path (seams diverge; not claimed equal).
 * pass / detect / auto / rescan keep the extract engine only.
 */
export function normalizeMessage(input: MessageInput, opts: NormalizeOptions = {}): NormalizeMessageResult {
  // Shared validation before either path (throws must match)
  ensureBuiltins();
  const mode = opts.mode ?? "repair";
  NormalizeError.invariant(mode !== "strict" || opts.tools, "strict_without_tools", "mode strict requires tools[]");
  if (opts.dialect && opts.dialect !== "auto") {
    const forced = resolveDialectId("", { dialect: opts.dialect });
    NormalizeError.invariant(forced.dialect != null, "unknown_dialect", `unknown dialect: ${opts.dialect}`);
  }

  if (canAssembleBatch(opts)) {
    return normalizeMessageViaAssemble(input, opts);
  }
  return normalizeMessageImpl(input, opts);
}

/**
 * Extract / resolve engine (batch spine). Stream EOS reuses this so live IR
 * and batch share one tool/finish truth — not a second parser.
 * @internal exported for normalize-stream EOS / probes
 */
export function normalizeMessageImpl(input: MessageInput, opts: NormalizeOptions = {}): NormalizeMessageResult {
  ensureBuiltins();
  const mode = opts.mode ?? "repair";
  const nativePolicy = opts.nativePolicy ?? "merge";
  const idStyle = opts.idStyle ?? "stable";
  const thinkTags = opts.thinkTags;
  const toolsInThinking = opts.toolsInThinking ?? "ignore";

  NormalizeError.invariant(mode !== "strict" || opts.tools, "strict_without_tools", "mode strict requires tools[]");

  // Forced unknown dialect always throws
  if (opts.dialect && opts.dialect !== "auto") {
    ensureBuiltins();
    const forced = resolveDialectId("", { dialect: opts.dialect });
    NormalizeError.invariant(forced.dialect != null, "unknown_dialect", `unknown dialect: ${opts.dialect}`);
  }

  const contentIn = typeof input === "string" ? input : (input.content ?? "");
  const nativeIn: ToolCall[] =
    typeof input === "string"
      ? []
      : (input.tool_calls ?? []).map((t) => ({
          id: t.id,
          type: "function" as const,
          function: {
            name: t.function.name,
            arguments: t.function.arguments && t.function.arguments.length > 0 ? t.function.arguments : "{}",
          },
        }));
  const reasoningIn = typeof input === "string" ? null : (input.reasoning_content ?? null);

  if (mode === "pass") {
    const think = splitThink(contentIn, thinkTags);
    const reasoning = mergeReasoning(reasoningIn, think.reasoning);
    const meta = emptyMeta("openai");
    meta.toolsInThinkingCount = think.reasoningToolHits;
    const tool_calls = nativeIn.map((t, i) =>
      t.id
        ? t
        : {
            ...t,
            id: mintId(i, t.function.name, t.function.arguments, idStyle),
          },
    );
    return {
      content: think.content.length > 0 ? think.content : null,
      tool_calls,
      reasoning_content: reasoning,
      finish_reason: repairFinish("pass", opts.finishReasonIn, tool_calls.length > 0),
      meta,
    };
  }

  const think = splitThink(contentIn, thinkTags);
  let reasoning = mergeReasoning(reasoningIn, think.reasoning);
  const toolsInThinkingCount = think.reasoningToolHits;

  const { masked } = maskFences(think.content);

  let scanContent = true;
  if (nativePolicy === "skip" && nativeIn.length > 0) scanContent = false;

  const { dialect, id: dialectId } = scanContent ? resolveDialectSoft(masked, opts) : { dialect: null, id: "none" };

  // For skip: still resolve dialect on content so we can strip markup (M3)
  const stripDialect = !scanContent && nativePolicy === "skip" ? resolveDialectSoft(masked, opts).dialect : null;

  const meta = emptyMeta(dialectId);
  meta.toolsInThinkingCount = toolsInThinkingCount;

  const { nameAliases, argAliases } = effectiveAliases(dialectId, opts);

  let recovered: ToolCall[] = [];
  let recoveredPartialLocal: number[] = [];
  let toolSpans: Array<{ start: number; end: number }> = [];
  let contentAfter = think.content;

  if (mode === "detect") {
    if (dialect && scanContent) {
      const ex = dialect.extract(masked, {});
      meta.candidates = ex.toolSpans.map((s) => ({
        dialect: dialectId,
        start: s.start,
        end: s.end,
      }));
    }
    return {
      content: think.content.length > 0 ? think.content : null,
      tool_calls: nativeIn,
      reasoning_content: reasoning,
      finish_reason: repairFinish("detect", opts.finishReasonIn, nativeIn.length > 0),
      meta,
    };
  }

  if (dialect && scanContent) {
    // Match on masked (fences blanked); bodies sliced from original (C2/R1)
    const ex = dialect.extract(masked, { original: think.content });
    toolSpans = ex.toolSpans;
    contentAfter = cleanupContent(think.content, toolSpans) ?? "";
    const proc = processRawCalls(
      ex.raw_calls,
      {
        mode: mode as "repair" | "strict",
        tools: opts.tools,
        nameAliases,
        argAliases,
        idStyle,
        requireKnownTool: opts.requireKnownTool,
        truncated: ex.truncated,
      },
      meta,
    );
    recovered = proc.calls;
    recoveredPartialLocal = proc.partialLocal;
    if (recovered.length > 0) meta.estimated = true;
  } else if (stripDialect) {
    const ex = stripDialect.extract(masked, { original: think.content });
    toolSpans = ex.toolSpans;
    contentAfter = cleanupContent(think.content, toolSpans) ?? "";
  } else {
    contentAfter = think.content;
  }

  if (toolsInThinking === "extract" && reasoning) {
    // Fence law applies to reasoning too (audit-010 H3). Same-length mask.
    const { masked: reasoningMasked } = maskFences(reasoning);
    const { dialect: rd, id: rid } = resolveDialectSoft(reasoningMasked, opts);
    if (rd) {
      const ex = rd.extract(reasoningMasked, { original: reasoning });
      const proc = processRawCalls(
        ex.raw_calls,
        {
          mode: mode as "repair" | "strict",
          tools: opts.tools,
          nameAliases: effectiveAliases(rid, opts).nameAliases,
          argAliases: effectiveAliases(rid, opts).argAliases,
          idStyle,
          requireKnownTool: opts.requireKnownTool,
          truncated: ex.truncated,
        },
        meta,
      );
      for (const p of proc.partialLocal) {
        recoveredPartialLocal.push(recovered.length + p);
      }
      recovered = [...recovered, ...proc.calls];
      if (ex.toolSpans.length > 0) {
        reasoning = cleanupContent(reasoning, ex.toolSpans);
      }
      if (proc.calls.length > 0) meta.estimated = true;
    }
  }

  let natives = nativeIn.map((t, i) =>
    t.id
      ? t
      : {
          ...t,
          id: mintId(i, t.function.name, t.function.arguments, idStyle),
        },
  );

  if (mode === "repair" || mode === "strict") {
    natives = resolveNativeNames(
      natives,
      {
        mode: mode as "repair" | "strict",
        tools: opts.tools,
        nameAliases,
        argAliases,
      },
      meta,
    );
  }

  let tool_calls: ToolCall[];
  if (nativePolicy === "rescan") {
    tool_calls = recovered;
    meta.partial = [...recoveredPartialLocal];
  } else if (nativePolicy === "skip") {
    tool_calls = natives;
    meta.partial = [];
  } else {
    const merged = mergeWithPartial(natives, recovered, recoveredPartialLocal);
    tool_calls = merged.tool_calls;
    meta.partial = merged.partial;
  }

  // S1: a call missing a schema-required argument must never be executable.
  // Dialect-agnostic, applied once here (both extract-truncated and native
  // paths funnel through this final tool_calls array) — AFTER the repair
  // ladder above (processRawCalls / normalizeNativeArgs already ran
  // schemaRepairArgsJson), so a value the ladder could still coerce isn't
  // flagged prematurely. Inert without a catalog / parameters / required[].
  if (opts.tools?.length) {
    const partialSet = new Set(meta.partial);
    for (const [i, tool_call] of tool_calls.entries()) {
      if (partialSet.has(i)) continue;
      const tc = tool_call!;
      const argsObj = parseArgsObject(tc.function.arguments);
      if (isMissingRequired(tc.function.name, argsObj, opts.tools)) {
        meta.partial.push(i);
      }
    }
  }

  // Truncated recovered: blank args so half-writes don't execute
  for (const pi of meta.partial) {
    const t = tool_calls[pi];
    if (!t) continue;
    tool_calls[pi] = {
      ...t,
      function: { ...t.function, arguments: "{}" },
    };
  }

  const content = contentAfter && contentAfter.length > 0 ? contentAfter : null;

  return {
    content,
    tool_calls,
    reasoning_content: reasoning,
    finish_reason: repairFinish(mode, opts.finishReasonIn, tool_calls.length > 0),
    meta,
  };
}
