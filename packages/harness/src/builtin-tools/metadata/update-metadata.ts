/** Record a normalized session label on this invocation's trajectory. */
import invariant from "tiny-invariant";
import {
  clampChars,
  METADATA_SAME_ROUND_NOTE,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  UPDATE_METADATA_TOOL_NAME,
  type SessionMetadataAction,
} from "@inhuman.tools/harness-model";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";

export const updateMetadataTool = new InhumanTool({
  name: UPDATE_METADATA_TOOL_NAME,
  description: `Record this turn's title and a short description. ${METADATA_SAME_ROUND_NOTE} Do not address the user.`,
  class: "meta",
  representation: "both",
  continuation: { kind: "auxiliary", note: METADATA_SAME_ROUND_NOTE },
  isSideChannel: true,
  tapeHidden: true,
  input: z.object({
    current_turn_title: z.string().describe("Session-list title, one line."),
    current_turn_description: z.string().optional().describe("What this turn is doing."),
  }),
  output: toolResultSchema,
  run: (input, ctx) => {
    const title = clampChars(input.current_turn_title.trim(), SESSION_TITLE_MAX_CHARS);
    const description = clampChars((input.current_turn_description ?? "").trim(), SESSION_DESCRIPTION_MAX_CHARS);
    if (title === "") return { ok: false, text: "current_turn_title must not be blank" };
    invariant(ctx.storage != null, "update_metadata requires session storage");
    ctx.storage.propose({ type: "metadata-updated", title, description } satisfies SessionMetadataAction);
    return { ok: true, value: { current_turn_title: title, current_turn_description: description } };
  },
});
