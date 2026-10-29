/**
 * Named-agent stdlib as a system plugin. Same `InhumanPlugin` `{ bots }` bag
 * a botmaker authors. Runtime does not special-case these names.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import { type BotDefinition, InhumanPlugin } from "@inhuman.tools/plugin-sdk";
import dedent from "dedent";

import { type CatalogRecipe } from "@/tool-catalog";

const OBSERVE = ["glob", "grep", "fff_search", "read_file", "list_dir"] as const;
const NOTES = [...OBSERVE, "write_file"] as const;
const PATCH = [...OBSERVE, "write_file", "edit_file", "shell"] as const;

function sessionBot(
  bot: Omit<BotDefinition, "recipeScope"> & {
    readonly recipeScope?: BotDefinition["recipeScope"];
  },
): BotDefinition {
  return { recipeScope: "session", ...bot };
}

export const NAMED_AGENT_BOTS: readonly BotDefinition[] = [
  sessionBot({
    name: "quick-search",
    description: "cite matching paths; agent/ask for map",
    reasoningEffort: "low",
    tools: [...OBSERVE],
    instructions: prompt.system`Find, cite paths, stop. Do not narrate a tour. Do not write. Prefer glob/grep/fff_search then a tight read. Answer with file:line when you have it.`,
  }),
  sessionBot({
    name: "explore",
    description: "thorough read-only repo investigation",
    reasoningEffort: "medium",
    tools: [...OBSERVE, "shell"],
    instructions: prompt.system`Investigate the repo. Read-only: git and ls via shell are fine; do not write, commit, or install. Exhaust search, cite paths, show the evidence chain. Stop when the question is answered.`,
  }),
  sessionBot({
    name: "web-research",
    description: "search and extract the public web; cite sources",
    reasoningEffort: "medium",
    tools: ["web_search", "web_extract"],
    instructions: prompt.system`Search and extract the public web. Cite sources. An empty extract is a miss, not a guess. Do not invent URLs.`,
  }),
  sessionBot({
    name: "implementer",
    description: "isolated change from a brief; agent/ask for no history",
    reasoningEffort: "high",
    tools: [...PATCH],
    invokes: ["reviewer"],
    instructions: prompt.system`Implement the brief. Smallest change that matches existing patterns. Do not add unasked features. Do not refactor past the ask. Summarize what changed. You may ask reviewer — that critic is this session's, not the caller's.`,
  }),
  sessionBot({
    name: "test-writer",
    description: "write and run tests for a named surface",
    reasoningEffort: "high",
    tools: [...PATCH],
    instructions: prompt.system`Write tests for the named surface. Follow in-repo conventions. Run them. Report failures with paths. Do not change production code unless the brief says so.`,
  }),
  sessionBot({
    name: "security-auditor",
    description: "find exploitable issues; do not patch",
    reasoningEffort: "high",
    tools: [...OBSERVE, "shell"],
    instructions: prompt.system`Find exploitable issues. Cite file:line. Do not patch. Do not inflate style into severity. Empty result is allowed when the surface is clean.`,
  }),
  sessionBot({
    name: "design-writer",
    description: "write a design doc from a brief",
    reasoningEffort: "high",
    tools: [...OBSERVE, "write_file"],
    instructions: prompt.system`Write a design doc from the brief, at the path given. Do not implement. Name assumptions, state machines, and unowned seams.`,
  }),
  sessionBot({
    name: "design-reviewer",
    description: "stress-test a design; do not rewrite it",
    reasoningEffort: "high",
    tools: [...NOTES],
    instructions: prompt.system`Stress-test the design. Missing assumptions, undefined state machines, unowned seams. Cite the doc. Do not rewrite it. Notes file only if a path is given.`,
  }),
  sessionBot({
    name: "reviewer",
    description: "persistent reviewer for this session; later requests continue the same conversation",
    reasoningEffort: "high",
    tools: [...NOTES],
    instructions: prompt.system`Critique the subject. Correctness first, then breakage, style last and only when load-bearing. Cite file:line. Do not edit the subject. Structured notes if a path is given. When reused, remember prior notes in this chat.`,
  }),
];

export const namedAgentsPlugin = new InhumanPlugin({ bots: NAMED_AGENT_BOTS });

/** Parent-facing inventory. `description` is the one-liner; skip recipes that omit it. */
export function namedAgentInventory(recipes: readonly CatalogRecipe[]): string {
  const rows = recipes.filter((recipe) => recipe.spec.description.trim() !== "");
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((recipe) => recipe.spec.name.length));
  return dedent`
    Bots — (bot/ask spec message) reuses the worker for this session; (agent/ask spec message) creates a disposable worker for that request. A schema is legal on (agent/ask spec message schema …) and on omitted-spec (bot/ask message schema), not on a standing named bot/ask.
    ${rows.map((recipe) => `${recipe.spec.name.padEnd(width)}  ${recipe.spec.description.trim()}`).join("\n")}
    (bot/ask message [schema]) omits spec for an anonymous worker this session reuses. agent/ask requires spec.
  `;
}
