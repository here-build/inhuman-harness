/**
 * Live `scheme_repl` tools[] description.
 *
 * Manifold law (arrival-manifold `buildCatalog`): world beat + derived slug
 * inventory + one signature line per bound tool. A cold model that never
 * calls cannot be taught by a door. Inventory names only bound slugs —
 * never capability kinds ("files", "repositories").
 *
 * Not the manifold renderer: kwargs `(server/tool :k v)` and "this is the
 * only tool" are the MCP-proxy world. Signatures come from `boundToolsOf`
 * (positional toolkit, pack symbols, `mcp/call`, `agent/*`).
 *
 * Completion faces: <12 live ids enumerate (prefix on the first only).
 * 12+ list operator recency, then "and N more".
 */
import { SCHEME_REPL_NAMING } from "@inhuman.tools/harness-model";
import { type CatalogRecipe, type KernelToolCatalog } from "@inhuman.tools/turn/catalog";
import dedent from "dedent";

import { boundToolsOf } from "./bound-tools.js";
import type { SchemeReplFaces } from "./connection-models.js";

const HOST_SLUGS = new Set(["toolkit", "shell", "named-agents", "web-search"]);
const MODEL_INVENTORY_ENUMERATE_MAX = 12;

function namedAgentInventory(recipes: readonly CatalogRecipe[]): string {
  const rows = recipes.filter((recipe) => recipe.spec.description.trim() !== "");
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((recipe) => recipe.spec.name.length));
  return dedent`
    Bots — (bot/ask spec message) reuses the worker for this session; (agent/ask spec message) creates a disposable worker for that request. A schema is legal on (agent/ask spec message schema …) and on omitted-spec (bot/ask message schema), not on a standing named bot/ask.
    ${rows.map((recipe) => `${recipe.spec.name.padEnd(width)}  ${recipe.spec.description.trim()}`).join("\n")}
    (bot/ask message [schema]) omits spec for an anonymous worker this session reuses. agent/ask requires spec.
  `;
}

export { SCHEME_REPL_DISPLAY_NOTE } from "@inhuman.tools/scheme-program";

export function schemeReplDescription(catalog: KernelToolCatalog, faces?: SchemeReplFaces): string {
  const tools = boundToolsOf(catalog);
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const tool of tools.values()) {
    const slug = tool.slug.trim();
    if (slug === "" || HOST_SLUGS.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  let models = "";
  if (faces != null && faces.connections.length > 0) {
    const usage = faces.modelsUsage;
    const ordered = [...faces.connections].sort((a, b) => {
      const aLarge = a.models.length >= MODEL_INVENTORY_ENUMERATE_MAX;
      const bLarge = b.models.length >= MODEL_INVENTORY_ENUMERATE_MAX;
      if (aLarge !== bLarge) return aLarge ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
    const lines = ordered.map((face) => {
      if (face.models.length === 0) return face.id;
      if (face.models.length < MODEL_INVENTORY_ENUMERATE_MAX) {
        return `${face.id} — ${face.models.map((id, index) => (index === 0 ? `${face.id}/${id}` : `/${id}`)).join(", ")}`;
      }
      const live = new Set(face.models);
      const prefix = `${face.id}/`;
      const recent = Object.entries(usage)
        .flatMap(([key, at]) => {
          if (!key.startsWith(prefix)) return [];
          const model = key.slice(prefix.length);
          if (model === "" || !live.has(model)) return [];
          return [{ model, at: Number(at) }];
        })
        .sort((a, b) => b.at - a.at || a.model.localeCompare(b.model))
        .map((row) => row.model)
        .slice(0, MODEL_INVENTORY_ENUMERATE_MAX);
      const more = face.models.length - recent.length;
      const refs = recent.map((id) => `${face.id}/${id}`).join(", ");
      if (refs === "") return `${face.id} — ${face.id} and ${more} more`;
      if (more <= 0) return `${face.id} — ${refs}`;
      return `${face.id} — ${refs}, and ${more} more`;
    });
    const firstLarge = ordered.find((face) => face.models.length >= MODEL_INVENTORY_ENUMERATE_MAX);
    models = [
      "Available models:",
      ...lines,
      ...(firstLarge == null
        ? []
        : [
            `to get the list with names of all models available for a specific connection, use (connection/models '${firstLarge.id})`,
          ]),
    ].join("\n");
  }
  return dedent`
  Evaluate a sandboxed Scheme program once in \`${SCHEME_REPL_NAMING.argName}\`.
  Multiple top-level forms run in one fresh scope (defines do not persist across calls).
  Do not wrap them in (begin …), (list …), or [] — those wrappers are spliced and each statement is returned as its own result.
  Scheme evaluation is synchronous except when waiting for tool calls.
  No inner-call or time limit unless maxInternalCalls or timeoutMs is set.
  Use scheme_watch only for requested recurring monitoring, not for ordinary agent calls or background work.
  Autonomous host JSON tools cannot be called from Scheme.
  ${
    slugs.length === 0
      ? undefined
      : dedent`
          The functions below span: ${slugs.join(", ")}.
          A task that mentions resources you have not seen in this conversation may be reachable through them — explore with these functions before asking the user.
        `
  }
  Toolkit functions take positional arguments: (read_file path), (list_dir path), (grep pattern), (glob pattern), (fff_search query), (write_file path contents), (edit_file path old new), (shell command), (web_search query), (web_extract url).
  Closed toolkit optionals are Arrival kwargs after the positionals: (read_file path :offset 2 :limit 10), (list_dir path :depth 2), (grep pattern :path "src" :glob "*.ts"), (write_file path contents :overwriteExisting #t), (edit_file path old new :replace_all #t), (shell command :cwd "bin" :timeoutMs 5000), (web_search query :numResults 5), (web_extract url :charLimit 4000).
  glob / fff_search take an optional trailing dict instead: (glob pattern {cwd: "src"}).
  MCP: (mcp/call connection tool :k v …) or a final dict — unknown keys must survive.
  Replacing an existing file needs (write_file path contents :overwriteExisting #t).
  (require path) and (load path) are the same: they read a workspace file through the program loader, not read_file.
  .scm spills defines into this run.
  .json / .yaml return data.
  .prompt returns a callable.
  Relative paths jail at the project root.
  Pack tools bind as their own symbols with the same positional/opts shape; the live catalog lists them.
  (update_metadata title [description]) records this turn's session-list label. A keyword tail or one dict carries the same fields.
  Bots: (bot/send spec message) waits until the standing bot responds or finishes without a response; the latter returns no value.
  (bot/ask spec message :readonly) waits for a standing bot's response. (bot/ask message [schema] :readonly) omits spec for an anonymous worker this session reuses. A schema is legal on (agent/ask spec message schema …) and on omitted-spec (bot/ask message schema), not on a standing named bot/ask.
  :readonly removes write_file, edit_file, and write-class MCP tools, but leaves shell available; it is not a guarantee against all mutations.
  (agent/call spec message :model) and (agent/ask spec message [schema] :readonly :model) create a new disposable worker for each call. Spec is required; keywords follow the message, not a trailing dict. Schema is positional after the message.
  :model is "connection/model" and pins that worker's completion wire.
  (connection/models connection) lists live model ids on that connection.
  (agent/message target message) delivers without waiting for a response.
  Finish a worker request with the agent__respond JSON tool, not (agent/respond); (agent/void id) still voids a send.
  Ask requires a response and rejects void.
  (agent/notify id message) sends an update without completing the request.
  Response schemas are Arrival s/* tags: (s/enum …), (s/string), (s/object (s/field …)), and the rest of that vocabulary.
  (self/notify message) sends an update without completing execution.
  Updates from a background program arrive as notifications in the conversation; when running inside a worker request, updates are attached to that request.
  Results are values — nest and compose in one program instead of round-tripping.
  Errors explain the expected form.
  In a single execution, later top-level forms still run after an error.
  Independent inner calls inside \`map\` run together; send/ask calls that reuse the same worker run sequentially on that worker.
  ${namedAgentInventory(catalog.allRecipes())}
  ${models}
  Examples:${"" /*examples are needed to both show model that it's real scheme, and not quazi-language, and to explain on the symbol usage patterns*/}
  (map (lambda (path) (agent/ask 'quick-search (string-append "who imports " path))) (glob "src/**/*.ts"))
  (bot/send 'reviewer "review the diff at HEAD")
  (bot/ask "ok?" (dict :answer (s/enum "yes" "no")))
  (agent/ask 'explore "how does auth start" :readonly #t :model "openai/chatgpt-5.6-luna")
  (mcp/call 'mail 'search :q "inbox")
  (mcp/call 'mail 'search (dict :q "inbox"))
  (write_file "notes.md" "# notes" :overwriteExisting #t)
  (require "skill-to-program/skill-to-program.scm")

  ${[...tools.values()].map((tool) => tool.signature().signatureText).join("\n")}`;
}
