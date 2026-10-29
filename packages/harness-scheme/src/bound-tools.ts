/**
 * Teaching projection of the catalog, and the invoke allowlist when `readonly`.
 * Connection rows carry slug+tool; pack rows carry pluginName + wire name.
 * scheme_repl is not a nested symbol.
 */
import {
  AGENT_ASK,
  AGENT_MESSAGE,
  AGENT_NOTIFY,
  AGENT_SEND,
  AGENT_VOID,
  UPDATE_METADATA_TOOL_NAME,
} from "@inhuman.tools/harness-model";
import type { BoundTool } from "@inhuman.tools/substrate/bound-tool";
import { orderedFields, type ToolJsonSchema } from "@inhuman.tools/substrate/tool-schema";
import type { KernelToolCatalog } from "@inhuman.tools/turn/catalog";

export function boundToolsOf(
  catalog: KernelToolCatalog,
  desk?: { readonly readonly?: boolean },
): ReadonlyMap<string, BoundTool> {
  const tools = new Map<string, BoundTool>();
  for (const entry of catalog.catalogEntries()) {
    if (entry.representation === "tool") continue;
    if (
      desk?.readonly === true &&
      (entry.wireName === "write_file" ||
        entry.wireName === "edit_file" ||
        (entry.source.kind === "connection" && entry.class === "write"))
    ) {
      continue;
    }
    const schema =
      entry.parameters.type !== undefined && entry.parameters.type !== "object"
        ? undefined
        : (entry.parameters as ToolJsonSchema);
    const slug = entry.source.kind === "connection" ? entry.source.connectionKey : entry.source.pluginName;
    const tool = entry.source.kind === "connection" ? entry.source.serverToolName : entry.wireName;
    tools.set(entry.wireName, {
      qualifiedName: entry.wireName,
      slug,
      tool,
      schema,
      signature: () => {
        const fields = orderedFields(schema);
        const params = fields.map((field) => {
          const type = field.prop.type;
          return {
            name: field.name,
            optional: field.optional,
            typeToken:
              typeof type === "string" ? type : Array.isArray(type) && typeof type[0] === "string" ? type[0] : "any",
            schema: field.prop,
          };
        });
        let signatureText: string;
        if (entry.source.kind === "connection") {
          signatureText = `(mcp/call '${slug} '${tool} args)`;
        } else
          switch (entry.wireName) {
            case AGENT_VOID: {
              signatureText = "(agent/void request-id)";

              break;
            }
            case AGENT_NOTIFY: {
              signatureText = "(agent/notify request-id message)";

              break;
            }
            case AGENT_MESSAGE: {
              signatureText = "(agent/message target message)";

              break;
            }
            case AGENT_SEND: {
              signatureText = "(bot/send spec message) | (agent/call spec message :model)";

              break;
            }
            case AGENT_ASK: {
              signatureText =
                "(bot/ask spec message :readonly) | (bot/ask message [schema] :readonly) | (agent/ask spec message [schema] :readonly :model)";

              break;
            }
            case UPDATE_METADATA_TOOL_NAME: {
              signatureText = "(update_metadata current_turn_title [current_turn_description])";

              break;
            }
            default: {
              const required = fields.filter((field) => !field.optional).map((field) => field.name);
              const optional = fields.filter((field) => field.optional).map((field) => field.name);
              // glob / fff_search take a trailing dict (optional positional).
              // Closed toolkit verbs take `:name` kwargs after the positionals.
              const dictOpts = entry.wireName === "glob" || entry.wireName === "fff_search";
              const kw = dictOpts ? (optional.length > 0 ? ["…opts"] : []) : optional.map((name) => `:${name}`);
              const tail = [...required, ...kw].join(" ");
              signatureText = tail === "" ? `(${entry.wireName})` : `(${entry.wireName} ${tail})`;
            }
          }
        return { params, signatureText };
      },
    });
  }
  return tools;
}
