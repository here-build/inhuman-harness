/**
 * One model tool_call. Abstract emission: identity and sealed receipt.
 * Concrete kinds are {@link SystemToolJob}, {@link FileMutateToolJob}, {@link MCPToolJob},
 * {@link WebSearchToolJob}, {@link WebExtractToolJob},
 * {@link AgentCallJob}, {@link BotCallJob}, {@link AgentCallbackJob}, {@link AgentNotifyJob},
 * {@link AgentMessageJob}, and {@link ContextNeedToolJob}. Call, message,
 * callback, and notify are COMM FIRST — they skip the floor. Child tools
 * still license.
 */
import { syncing } from "@here.build/plexus";
import { type JobResolution } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto, syncingText } from "../../json-record.js";
import { type ToolOutcomeSnap } from "../../schemas/index.js";
import { stripShellObservation, stripVt } from "../../vt-text.js";
import type { AuthCluster } from "../authorization/config.js";
import type { CallSubject } from "../authorization/resolve.js";
import { clusterOf } from "../cluster.js";
import type { JudgeResult, PolicyResult } from "../eval-context.js";
import { parseToolOutcome, receiptResult } from "../tool-outcome.js";
import { ApprovableJob } from "./ApprovableJob.js";

export type ToolCallJobProps = {
  readonly toolCallId?: string;
  readonly name?: string;
  /** The MCP server this call belongs to, for a tool a host runs itself. Rules `{mcp, tool}` match it. */
  readonly mcpServer?: string;
  readonly argsJson?: string | null;
  readonly outcomeJson?: string | null;
  readonly regenerateable?: boolean;
  readonly retentionJson?: string;
  readonly pluginMeta?: Record<string, string>;
  readonly triggersReactLoop?: boolean;
  readonly isSideChannel?: boolean;
  readonly tapeHidden?: boolean;
  readonly humanApprove?: true | false | null;
  readonly approvalComment?: string | null;
  readonly policyResult?: PolicyResult;
  readonly policyEvidenceJson?: string | null;
  readonly policyMessage?: string | null;
  readonly classifierResult?: JudgeResult;
  readonly classifierAbstain?: string | null;
  readonly policyClassesJson?: string | null;
  readonly policyVotesJson?: string | null;
  readonly grantedBy?: string | null;
  readonly judgeReason?: string | null;
  readonly softDenyRound?: 1 | 2 | null;
  readonly judgeFails?: number;
  readonly background?: boolean;
  readonly walkBoundary?: boolean;
  readonly orchestrationResult?: true | false | null;
  readonly cancelled?: boolean;
  readonly completed?: boolean;
  /** Call-start identity. Empty on a child minted before tracks. */
  readonly track?: string;
};

/** Download-exec (`npx`, `bunx`, `uvx`, `pnpm dlx`, `yarn dlx`): runs code fetched just now. */
export function isShellHatch(command: string): boolean {
  return /\b(?:npx|bunx|uvx|(?:pnpm|yarn)\s+dlx)\b/.test(command);
}

@syncing("harness:job:tool-call")
export abstract class ToolCallJob extends ApprovableJob<unknown, string> {
  @syncing accessor toolCallId: string = "";
  @syncing accessor name: string = "";
  /**
   * The MCP server a host-run tool belongs to (a system tool the catalog admits under a server name).
   * Empty: a plain native tool. An {@link MCPToolJob} gets its server from the connection instead.
   */
  @syncing accessor mcpServer: string = "";
  @syncing private accessor argsJson: string | null = null;
  @syncing protected accessor outcomeJson: string | null = null;
  /**
   * Catalog `read` — re-invoke instead of `/tmp`. Default persist.
   * Admit stamps this from catalog class so a denied read is not persistable.
   */
  @syncing accessor regenerateable: boolean = false;
  /**
   * R2. The resolved retention rule (`{kind, keep, leave, minChars, onError}`
   * as JSON) stamped at admit. Empty = unstamped; the projection falls back
   * to the legacy rule. Catalog churn and config edits cannot reclassify
   * history because this is read instead of the live catalog.
   */
  @syncing accessor retentionJson: string = "";
  /** Plugin id → envelope JSON. The projection is computed; this is the fact. */
  @syncing.record accessor pluginMeta: Record<string, string> = {};
  /** Stamped from the catalog at admission. */
  @syncing accessor triggersReactLoop: boolean = true;
  /** Stamped from the catalog at admission. Skips the license floor. */
  @syncing accessor isSideChannel: boolean = false;
  @syncing accessor tapeHidden: boolean = false;
  /**
   * Claimed when the crossing starts: `[tick origin, …closure window, n]`.
   * Empty means this child predates tracks and resume still walks by position.
   */
  @syncing accessor track: string = "";

  constructor(props?: ToolCallJobProps | symbol) {
    super(props);
  }

  @serializingInto("argsJson")
  accessor args: ReadonlyDeep<Record<string, unknown>> | null = null;

  argString(key: string): string {
    const value = this.args?.[key];
    return typeof value === "string" ? value : "";
  }

  /**
   * Scheme kwargs paint for representations and compact. The OpenAI wire
   * still carries JSON `arguments`.
   *
   * A top-level key that is not a keyword atom has no quoted-key form, so
   * this keeps `argsJson` instead of emitting broken scheme. Nested dict
   * keys may quote. Strings stay quoted — a bare path would be a symbol.
   * The illegal-key fallback is untested; dropping it would hand compact
   * broken scheme.
   */
  invocation(): string {
    const raw = syncingText(this.argsJson) ?? "";
    const args = this.args;
    if (args == null) return raw;
    const entries = Object.entries(args);
    if (entries.length === 0) return `(${this.name})`;
    if (entries.some(([key]) => !BARE_KEY.test(key))) return raw;
    const kwargs = entries.map(([key, value]) => `:${key} ${renderLiteral(value)}`).join(" ");
    return `(${this.name} ${kwargs})`;
  }

  sealedOutcomeJson(): string | null {
    const text = syncingText(this.outcomeJson);
    if (text != null && text !== "") return text;
    return null;
  }

  /** Stored receipt text. Empty and missing stay distinct; this is not {@link outcomeSnap}. */
  get receiptJson(): string | null {
    return syncingText(this.outcomeJson);
  }

  set receiptJson(next: string | null) {
    this.outcomeJson = next;
  }

  @computed
  override get result(): JobResolution<unknown, string> | null {
    return receiptResult(this.endedAtMs, this.outcomeSnap);
  }

  @computed
  get outcomeSnap(): ToolOutcomeSnap | undefined {
    return parseToolOutcome(this.sealedOutcomeJson());
  }

  set outcomeSnap(next: ToolOutcomeSnap) {
    this.outcomeJson = JSON.stringify(next);
  }

  observationPayload(): unknown {
    const snap = this.outcomeSnap;
    if (snap === undefined) {
      const json = this.sealedOutcomeJson();
      return json ?? "";
    }
    if (this.name === "shell") {
      if ("value" in snap) return stripShellObservation(snap.value);
      if (typeof snap.text === "string") return stripVt(snap.text);
      return "";
    }
    if ("value" in snap) return snap.value;
    if (typeof snap.text === "string") return snap.text;
    return "";
  }

  @syncing.action
  stampPluginMeta(pluginId: string, encoded: string): void {
    this.pluginMeta[pluginId] = encoded;
  }

  @computed
  override get authCluster(): AuthCluster {
    return clusterOf(this.name);
  }

  @computed
  override get grantToolName(): string {
    return this.name;
  }

  /** A host-run tool under an MCP server is that server's tool: rules, grants and the prompt see `{server, tool}`. */
  @computed
  override get grantMcp(): { readonly server: string; readonly account: string; readonly tool: string } | undefined {
    return this.mcpServer === "" ? undefined : { server: this.mcpServer, account: this.mcpServer, tool: this.name };
  }

  /** The voting units and paths of the floor, for command-family and path entries. */
  @computed
  override get callSubject(): CallSubject {
    const tier = this.policyResult;
    const votes = this.policyVotes.filter((vote) => vote.disposition === tier);
    return {
      tool: this.name,
      ...(this.grantMcp === undefined ? {} : { mcp: this.grantMcp }),
      units: votes.flatMap((vote) => (vote.unit === undefined ? [] : [vote.unit])),
      paths: votes.flatMap((vote) => (vote.path === undefined ? [] : [vote.path])),
    };
  }

  @computed
  override get hatch(): boolean {
    if (this.name !== "shell") return false;
    const command = this.args?.command;
    return typeof command === "string" && isShellHatch(command);
  }
}

/** Keyword-atom keys. Nested dict keys may quote; top-level kwargs may not. */
const BARE_KEY = /^[a-z][\w-]*$/i;

function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "#t" : "#f";
  if (Array.isArray(value)) return `[${value.map((item) => renderLiteral(item)).join(" ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      const renderedKey = BARE_KEY.test(key) ? `:${key}` : `"${escapeString(key)}"`;
      return `${renderedKey} ${renderLiteral(nested)}`;
    });
    return `{${pairs.join(" ")}}`;
  }
  return `"${escapeString(String(value))}"`;
}

function escapeString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`)
    .replaceAll("\r", String.raw`\r`);
}
