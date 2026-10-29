/**
 * Side-channel session label. BODY is an ack; display derives from the
 * job args on the surviving turn. Not FS, not approval, not ReACT-alone.
 */
import {
  clampChars,
  METADATA_SAME_ROUND_NOTE,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  UPDATE_METADATA_TOOL_NAME,
} from "@inhuman.tools/harness-model";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";

export const updateMetadataTool = new InhumanTool({
  name: UPDATE_METADATA_TOOL_NAME,
  description: `Record this turn's title and a short description. ${METADATA_SAME_ROUND_NOTE} Do not address the user.`,
  class: "meta",
  representation: "both",
  triggersReactLoop: false,
  isSideChannel: true,
  tapeHidden: true,
  input: z.object({
    current_turn_title: z.string().describe("Session-list title, one line."),
    current_turn_description: z.string().optional().describe("What this turn is doing."),
  }),
  output: toolResultSchema,
  run: (input) => ({
    ok: true as const,
    value: {
      current_turn_title: clampChars(input.current_turn_title.trim(), SESSION_TITLE_MAX_CHARS),
      current_turn_description: clampChars(
        (input.current_turn_description ?? "").trim(),
        SESSION_DESCRIPTION_MAX_CHARS,
      ),
    },
  }),
});
