/**
 * Identity line from argsJson. Never a file count. No duration.
 * Scheme outer is sugarcoat of expr(); tools use .name + args.
 * Shell tape skips pretty-mcp `run`/`ran` — gutter `$`, bash command
 * (or optional `description` on the collapsed row). A cwd other than `.`
 * is the line after that call, not a right column. No `exit N` — fail
 * is the gutter. Command display is an shfmt reprint; argsJson is what runs.
 */
import {
  AgentCallJob,
  CallJob,
  AgentMessageJob,
  type KernelRoot,
  MCPToolJob,
  ProgrammaticJob,
  FileMutateToolJob,
  ToolCallJob,
  TurnNotificationChunk,
  BotCallJob,
} from "@inhuman.tools/harness-model";
import { renderMustache, splitIdentity } from "@inhuman.tools/pretty-mcp";

import {
  agentCoverVerb,
  formatAgentCoverAnnotation,
  formatAskAgentWho,
  type CoverAskContext as AgentCoverAskContext,
} from "./agent-cover.js";
import { formatShellCommand } from "./format-shell.js";
import { mcpIdentity } from "./mcp-identity.js";
import { prettyIdentity, stripQuestion } from "./pretty-identity.js";
import { sugarcoatProgram } from "./sugarcoat.js";

export type CoverAskContext = AgentCoverAskContext & {
  readonly kernel?: KernelRoot | null;
  /** Recipe name when a worker tool (not the spawn) sits on the host cover. */
  readonly agentSpec?: string;
};

/** Wire name of the scheme-repl bag. Same string as SCHEME_REPL_TOOL_NAME. */
export const SCHEME_REPL_NAME = "scheme_repl";

/** Wire name of the scheme-watch bag. Same string as SCHEME_WATCH_TOOL_NAME. */
export const SCHEME_WATCH_NAME = "scheme_watch";

/** Collapsed caption XOR the program. Both bags, not only the repl. */
export function isSchemeBagName(name: string): boolean {
  return name === SCHEME_REPL_NAME || name === SCHEME_WATCH_NAME;
}

export type IdentityLine = {
  readonly name: string;
  readonly object: string;
  readonly status: string;
  /** Collapsed tape token. Command / expr (`object`) is on expand. */
  readonly caption?: string;
  /** pretty-mcp telegram is the whole row; `name` stays the wire name. */
  readonly pretty?: boolean;
  readonly block?: string;
  readonly agent?: boolean;
};

export const CAPTION_MAX_CODE_POINTS = 80;

/** TUI emits `…`. sdk glance `clampChars` does not — sharing the helper drops the ellipsis. */
export function captionFromArgs(args: Record<string, unknown> | null): string | undefined {
  if (args === null) return undefined;
  const raw = args.description;
  if (typeof raw !== "string") return undefined;
  const flat = raw.replaceAll(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  const points = [...flat];
  if (points.length <= CAPTION_MAX_CODE_POINTS) return flat;
  return `${points.slice(0, CAPTION_MAX_CODE_POINTS - 1).join("")}…`;
}

export function tailEllipsis(path: string, width: number): string {
  if (width < 2) return "…";
  if (path.length <= width) return path;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const marked = slash >= 0 ? `/${file}` : file;
  if (marked.length + 1 <= width) return `…${marked}`;
  return `…${file.slice(-(width - 1))}`;
}

/** Replica strings can be `null` while a room is still settling. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArg(args: Readonly<Record<string, unknown>> | null, key: string): string | undefined {
  if (args === null) return undefined;
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Token the model wrote. Relative keeps `./` / `../`; `.` is omitted. */
function shellCwdToken(args: Readonly<Record<string, unknown>> | null): string {
  const cwd = stringArg(args, "cwd");
  if (cwd === undefined || cwd === ".") return "";
  if (cwd.startsWith("/") || cwd.startsWith("\\") || cwd.startsWith(".")) return cwd;
  return `./${cwd}`;
}

function fallbackObject(work: ToolCallJob): string {
  const invoked = work.invocation();
  const args = work.args;
  if (args == null) return invoked.length > 48 ? `${invoked.slice(0, 47)}…` : invoked;
  const raw = JSON.stringify(args);
  if (invoked !== raw) return invoked;
  return raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
}

export function isPathShapedName(name: string): boolean {
  return name === "read_file" || name === "list_dir" || name === "write_file" || name === "edit_file";
}

/** File mutations paint as open Diff blocks; identity is the path, not a telegram. */
export function isMutateName(name: string): boolean {
  return name === "edit_file" || name === "write_file";
}

/**
 * True when edit/create args would paint a Diff (pin or sealed).
 * `write_file` that existed without stored prior text is not a create Diff —
 * same cut as `writeFileDiff` in work-cells. A prior held in a blob is stored:
 * its text arrives after the document names it.
 */
export function mutateArgsHaveDiff(work: ToolCallJob): boolean {
  if (!isMutateName(work.name)) return false;
  const args = work.args;
  if (work.name === "edit_file") {
    return argString(args, "old_string") !== "" || argString(args, "new_string") !== "";
  }
  if (argString(args, "content") === "") return false;
  if (work instanceof FileMutateToolJob && work.existed === true && work.prior === null) {
    return false;
  }
  return true;
}

function argString(args: Record<string, unknown> | null, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value : "";
}

function flattenLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function prettySentence(
  name: string,
  object: string,
  extras: { readonly caption?: string; readonly block?: string } = {},
): IdentityLine {
  const caption = extras.caption !== undefined && extras.caption !== "" ? extras.caption : undefined;
  const block = extras.block !== undefined && extras.block !== "" ? extras.block : undefined;
  return {
    name: asText(name),
    object: stripQuestion(asText(object)),
    status: "",
    pretty: true,
    ...(caption === undefined ? {} : { caption }),
    ...(block === undefined ? {} : { block }),
  };
}

/** Args plus sealed outcome object. Sentences stay on the plugin face. */
function pluginFaceBag(work: ToolCallJob): Record<string, unknown> {
  const args = work.args ?? {};
  const bag: Record<string, unknown> = { ...args };
  const snap = work.outcomeSnap;
  const value = snap?.ok === true ? snap.value : undefined;
  if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, field] of Object.entries(value)) {
      const prior = bag[key];
      if (prior !== undefined && prior !== "") continue;
      if (field === undefined || field === "") continue;
      bag[key] = field;
    }
  }
  for (const key of Object.keys(bag)) {
    const text = bag[key];
    if (typeof text === "string") bag[key] = flattenLine(text);
  }
  return bag;
}

export function pluginFaceIdentity(
  work: ToolCallJob | ProgrammaticJob,
  kernel?: KernelRoot | null,
): IdentityLine | null {
  if (kernel == null) return null;
  if (work instanceof ProgrammaticJob) return null;
  const name = asText(work.name);
  if (name === "") return null;
  const spec = kernel.pluginTool(name);
  if (spec == null || (spec.question == null && spec.effect == null)) return null;
  const bag = pluginFaceBag(work);
  const sealed = work.completed || work.cancelled === true;
  const template = sealed && spec.effect != null ? spec.effect : (spec.question ?? spec.effect);
  if (template == null) return null;
  const markdown = renderMustache(template, bag).replace(/\n+$/, "");
  if (markdown.trim() === "") return null;
  const { line, block } = splitIdentity(markdown);
  const caption = spec.caption == null ? undefined : flattenLine(renderMustache(spec.caption, bag));
  return prettySentence(name, line, {
    caption,
    block,
  });
}

/** Path + optional status. No wire name — the gutter already marks the row. */
export function formatMutateIdentity(line: Pick<IdentityLine, "object" | "status">, width: number): string {
  const suffix = line.status === "" ? "" : `  ${line.status}`;
  const budget = Math.max(4, width - suffix.length);
  return `${tailEllipsis(line.object, budget)}${suffix}`;
}

function withCaption(line: IdentityLine, caption: string | undefined): IdentityLine {
  return caption === undefined ? line : { ...line, caption };
}

export function identityLine(work: ToolCallJob | ProgrammaticJob, kernel?: KernelRoot | null): IdentityLine {
  if (work instanceof ToolCallJob && work.name === "shell") {
    const args = work.args;
    const command = stringArg(args, "command");
    return withCaption(
      {
        name: "shell",
        object: command === undefined ? fallbackObject(work) : formatShellCommand(command),
        status: shellCwdToken(args),
      },
      captionFromArgs(args),
    );
  }
  const pluginFace = pluginFaceIdentity(work, kernel);
  if (pluginFace !== null) return pluginFace;
  if (work instanceof ProgrammaticJob) {
    const args = work.args;
    return withCaption(
      {
        name: asText(work.toolName),
        object: sugarcoatProgram(work.expr),
        status: "",
      },
      captionFromArgs(args),
    );
  }
  const pretty = prettyIdentity(work, work.completed || work.cancelled === true ? "effect" : "question");
  if (work instanceof MCPToolJob) {
    const mcp = mcpIdentity(work);
    if (pretty !== null) {
      return {
        name: asText(mcp.server),
        object: stripQuestion(asText(pretty.line)),
        status: "",
        pretty: true,
        block: pretty.block,
      };
    }
    return { name: asText(mcp.server), object: asText(mcp.action), status: "" };
  }
  if (work instanceof CallJob) {
    return {
      name: agentCallName(work),
      object: "",
      status: "",
      agent: true,
      block: agentSpawnPrompt(work),
    };
  }
  const args = work.args;
  const name = asText(work.name);
  let object: string;
  const status = "";
  switch (name) {
    case "read_file":
    case "list_dir":
    case "write_file":
    case "edit_file":
      object = stringArg(args, "path") ?? fallbackObject(work);
      break;
    case "glob":
    case "fff_search": {
      const head = stringArg(args, name === "glob" ? "pattern" : "query") ?? fallbackObject(work);
      const cwd = searchCwd(args);
      object = cwd === undefined ? head : `${head}  ${cwd}`;
      break;
    }
    case "grep": {
      const pattern = stringArg(args, "pattern") ?? fallbackObject(work);
      const path = stringArg(args, "path");
      object = path === undefined ? pattern : `${pattern}  ${path}`;
      break;
    }
    default: {
      let hit: string | undefined;
      for (const key of ["path", "uri", "command", "query", "pattern"]) {
        hit = stringArg(args, key);
        if (hit !== undefined) break;
      }
      if (hit === undefined && args !== null) {
        for (const value of Object.values(args)) {
          if (typeof value === "string" && value !== "") {
            hit = value;
            break;
          }
        }
      }
      object = hit ?? fallbackObject(work);
      break;
    }
  }
  if (isMutateName(name)) {
    return withCaption({ name, object, status }, captionFromArgs(args));
  }
  if (pretty !== null) {
    return { name, object: stripQuestion(pretty.line), status, pretty: true, block: pretty.block };
  }
  return { name, object, status };
}

export function formatIdentity(line: IdentityLine, width: number, pathShaped: boolean): string {
  const gap = line.status === "" ? `${line.name}  ` : `${line.name}  `;
  const suffix = line.status === "" ? "" : `  ${line.status}`;
  const budget = Math.max(4, width - gap.length - suffix.length);
  const object = pathShaped ? tailEllipsis(line.object, budget) : line.object;
  return `${gap}${object}${suffix}`;
}

/** glob / fff_search search root. `cwd` wins; `path` is the ingest alias. */
function searchCwd(args: Record<string, unknown> | null): string | undefined {
  return stringArg(args, "cwd") ?? stringArg(args, "path");
}

/** `**token**` closes early if the token itself contains `*` (glob stars). */
function emphasize(token: string): string {
  return token.includes("*") ? token : `**${token}**`;
}

function coverPathVerb(verb: string, args: Record<string, unknown> | null): string | undefined {
  const path = stringArg(args, "path");
  if (path === undefined) return undefined;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  if (file === "") return undefined;
  return `${verb} ${emphasize(file)}`;
}

export function agentCallName(work: CallJob): string {
  const spec = stringArg(work.args, "spec")?.trim() ?? "";
  if (spec !== "") return spec;
  const bot = work instanceof BotCallJob ? asText(work.botName).trim() || asText(work.contributionBotName).trim() : "";
  if (bot !== "") return bot;
  const face = work instanceof AgentCallJob ? (work.faceName ?? "").trim() : "";
  if (face !== "" && face !== "anonymous") return face;
  return "agent";
}

export function agentSpawnPrompt(work: CallJob): string {
  return stringArg(work.args, "message") ?? "";
}

export function notificationPaintText(chunk: TurnNotificationChunk): string {
  const lines = chunk.notifications.map((note) => {
    const home = note.parent;
    if (home instanceof CallJob) return `from ${agentCallName(home)}: ${note.message}`;
    const text = note.message.trim();
    return text === "" ? "" : text;
  });
  return lines.filter((line) => line !== "").join("\n");
}

/** Successful cutoff, or the human notice on a failed CompactJob. */
export function compactJobPaintText(notice: string, focus: string, failed: boolean): string {
  if (failed) {
    const text = notice.trim();
    return text === "" ? "couldn't compact — try again later" : text;
  }
  const trimmed = focus.trim();
  return trimmed === "" ? "compacted" : `compacted · ${trimmed}`;
}

/**
 * Isolated-cover rim (omnibox top-right). Markdown: furniture + `**bright**`
 * (chrome lifts emphasis to primary). MCP is server + action. Shell is
 * `run command` plus the cwd token when set — the command itself is the
 * composer stack, not this slot. Agent send/ask is dim `ask`/`send` + bright
 * `{model} {Spec} agent`; the prompt rides the stack. A worker tool on the
 * host cover prefixes `**{Spec} agent** ·` so the who is not the host.
 */
export function coverAskAnnotation(work: object | null | undefined, ctx?: CoverAskContext): string | undefined {
  if (work instanceof CallJob) {
    return formatAgentCoverAnnotation({
      verb: agentCoverVerb(work),
      model: ctx?.model ?? "",
      spec: agentCallName(work),
    });
  }
  if (work instanceof AgentMessageJob) {
    const args = work.args;
    const target = stringArg(args, "targetName") ?? stringArg(args, "targetId") ?? "";
    return formatAgentCoverAnnotation({
      verb: "message",
      model: "",
      spec: target,
    });
  }
  return prefixWorkerAsk(ctx?.agentSpec, coverAskToolAnnotation(work, ctx));
}

function coverAskToolAnnotation(work: object | null | undefined, ctx?: CoverAskContext): string | undefined {
  if (work instanceof ToolCallJob && work.name === "shell") {
    const cwd = shellCwdToken(work.args);
    return cwd === "" ? "run command" : `run command  ${cwd}`;
  }
  if (work instanceof MCPToolJob || work instanceof ToolCallJob || work instanceof ProgrammaticJob) {
    const pluginFace = pluginFaceIdentity(work, ctx?.kernel);
    if (pluginFace !== null) return pluginFace.object;
    const pretty = prettyIdentity(work, "question");
    if (pretty !== null) return stripQuestion(pretty.line);
  }
  if (work instanceof MCPToolJob) {
    const mcp = mcpIdentity(work);
    if (mcp.action === "") return undefined;
    return `${mcp.server} ${emphasize(mcp.action)}`;
  }
  if (!(work instanceof ToolCallJob)) return undefined;
  const args = work.args;
  switch (work.name) {
    case "edit_file":
      return coverPathVerb("edit", args);
    case "write_file":
      return coverPathVerb(work instanceof FileMutateToolJob && work.existed === true ? "update" : "create", args);
    case "read_file":
      return coverPathVerb("Read", args);
    case "list_dir":
      return coverPathVerb("list", args);
    case "grep": {
      const pattern = stringArg(args, "pattern");
      return pattern === undefined ? undefined : `grep ${emphasize(pattern)}`;
    }
    case "glob": {
      const pattern = stringArg(args, "pattern");
      if (pattern === undefined) return undefined;
      const cwd = searchCwd(args);
      return cwd === undefined ? `glob ${emphasize(pattern)}` : `glob ${emphasize(pattern)}  ${cwd}`;
    }
    case "fff_search": {
      const query = stringArg(args, "query");
      if (query === undefined) return undefined;
      const cwd = searchCwd(args);
      return cwd === undefined ? `search ${emphasize(query)}` : `search ${emphasize(query)}  ${cwd}`;
    }
    default:
      return undefined;
  }
}

function prefixWorkerAsk(spec: string | undefined, asked: string | undefined): string | undefined {
  if (spec === undefined) return asked;
  const who = emphasize(formatAskAgentWho(spec));
  if (asked == null || asked === "") return who;
  return `${who} · ${asked}`;
}

export function shellAskCommand(work: object | null | undefined): string | undefined {
  if (!(work instanceof ToolCallJob) || work.name !== "shell") return undefined;
  const command = stringArg(work.args, "command");
  return command === undefined ? undefined : formatShellCommand(command);
}
