/**
 * Ask-cover copy for agent send/ask/message. Rim is dim verb + bright
 * `{model} {Spec} agent`. Prompt (and spec one-liner) ride the composer
 * stack — same T-join as MCP options / shell command. Not a pin.
 *
 * Stdlib one-liners match the named-agent bot table
 * (`packages/harness/src/server/system-plugins/named-agents/agent-stdlib.ts`). User recipes
 * in `KernelRoot.bots` win on the same name.
 */
import { AgentCallJob, CallJob, AgentMessageJob, BotCallJob } from "@inhuman.tools/harness-model";

/** Wire name. Ask stamps `voidLegal` false; send and bot-call stay send. */
const AGENT_ASK_NAME = "agent__ask";

/** CHANGE ONLY with packages/harness/src/server/system-plugins/named-agents/agent-stdlib.ts one-liners. */
export const STDLIB_AGENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "quick-search": "cite matching paths; agent/ask for map",
  explore: "thorough read-only repo investigation",
  "web-research": "search and extract the public web; cite sources",
  implementer: "isolated change from a brief; agent/ask for no history",
  "test-writer": "write and run tests for a named surface",
  "security-auditor": "find exploitable issues; do not patch",
  "design-writer": "write a design doc from a brief",
  "design-reviewer": "stress-test a design; do not rewrite it",
  reviewer: "persistent reviewer for this session; later requests continue the same conversation",
};

export type AgentCoverVerb = "ask" | "send" | "message";

export type CoverAskContext = {
  /** Session `kvs.model` — the worker inherits this at mint. */
  readonly model?: string;
};

export function agentCoverVerb(work: CallJob | AgentMessageJob): AgentCoverVerb {
  if (work instanceof AgentMessageJob) return "message";
  return !work.voidLegal || work.name === AGENT_ASK_NAME || work.name === "bot__ask" ? "ask" : "send";
}

export function agentSpecKey(work: object | null | undefined): string {
  if (work instanceof CallJob) {
    const spec = stringArg(work.args, "spec")?.trim() ?? "";
    if (spec !== "") return spec;
    const bot = work instanceof BotCallJob ? work.botName.trim() || work.contributionBotName.trim() : "";
    if (bot !== "") return bot;
    const face = work instanceof AgentCallJob ? (work.faceName ?? "").trim() : "";
    if (face !== "" && face !== "anonymous") return face;
    return "";
  }
  if (work instanceof AgentMessageJob) {
    return stringArg(work.args, "targetName")?.trim() ?? "";
  }
  return "";
}

/** `quick-search` → `Quick Search`. Sentinel `agent` is anonymous, not a spec. */
export function titleAgentSpec(spec: string): string {
  const raw = (typeof spec === "string" ? spec : "").trim();
  if (raw === "" || raw === "agent") return "";
  return raw
    .split(/[-_]+/)
    .filter((part) => part !== "")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join(" ");
}

export function formatAskAgentWho(spec: string): string {
  const titled = titleAgentSpec(spec);
  return titled === "" ? "agent" : `${titled} agent`;
}

/**
 * Occupancy pin list. Oxford comma comes from `Intl.ListFormat` (`en-US`).
 * Noun is English v1 — one `agent` / many `agents` on the whole list.
 */
export function formatWaitingForAgents(specs: readonly string[], locale = "en-US"): string {
  const names = [...specs].map((spec) => titleAgentSpec(spec)).filter((name) => name !== "");
  if (names.length === 0) {
    if (specs.length === 0) return "";
    return specs.length === 1 ? "waiting for an agent" : "waiting for agents";
  }
  const who = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  const noun = names.length === 1 ? "agent" : "agents";
  return `waiting for ${who} ${noun}`;
}

/**
 * Isolated-cover rim. Markdown: furniture verb + `**bright**` who.
 * Message does not spawn — no model. Empty spec is still `… agent`.
 */
export function formatAgentCoverAnnotation(opts: {
  readonly verb: AgentCoverVerb;
  readonly model: string;
  readonly spec: string;
}): string {
  const model = opts.verb === "message" ? "" : opts.model.trim();
  const spec = titleAgentSpec(opts.spec);
  const who = [model, spec, "agent"].filter((part) => part !== "").join(" ");
  return `${opts.verb} **${who}**`;
}

export function agentCoverPrompt(work: CallJob | AgentMessageJob): string {
  return stringArg(work.args, "message") ?? "";
}

export function agentAskStackedBody(prompt: string, description: string): string {
  const desc = description.trim();
  if (desc === "") return prompt;
  if (prompt === "") return desc;
  return `${desc}\n\n${prompt}`;
}

export function agentExpandBlock(prompt: string, model: string): string {
  const body = prompt.trim();
  const who = model.trim();
  if (who === "") return body;
  if (body === "") return who;
  return `${body}\n${who}`;
}

export function agentRecipeDescription(
  bots: Readonly<Record<string, { readonly description?: string }>>,
  spec: string,
): string {
  const key = spec.trim();
  if (key === "") return "";
  const fromFile = (bots[key]?.description ?? "").trim();
  if (fromFile !== "") return fromFile;
  return STDLIB_AGENT_DESCRIPTIONS[key] ?? "";
}

function stringArg(args: Readonly<Record<string, unknown>> | null, key: string): string | undefined {
  if (args === null) return undefined;
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
