/**
 * Side-channel context expectation. BODY is an ack; the host derives
 * SessionTurn.contextNeed from the job. Not occupancy, not compact().
 */
import { CONTEXT_NEED_DESCRIPTION } from "@inhuman.tools/activity";
import { CONTEXT_NEED_TOOL_NAME } from "@inhuman.tools/harness-model";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";

export const contextNeedTool = new InhumanTool({
  name: CONTEXT_NEED_TOOL_NAME,
  description: CONTEXT_NEED_DESCRIPTION,
  class: "meta",
  representation: "both",
  triggersReactLoop: false,
  isSideChannel: true,
  tapeHidden: true,
  input: z.object({
    min_remaining_tokens: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Conservative number of free tokens needed for the next stretch of work, not an estimate of tokens currently available.",
      ),
    preserve: z
      .object({
        user_turns: z.number().int().nonnegative().optional().describe("Keep at least this many recent user turns."),
        rounds: z.number().int().nonnegative().optional().describe("Keep at least this many recent tool rounds."),
      })
      .optional()
      .describe("Minimum amounts of recent history to preserve if older context is reorganized."),
    focus: z.string().optional().describe("Information to emphasize if older context is reorganized."),
    current_phase_settled: z.literal(true).optional().describe("Current reasoning phase reached a clean boundary."),
  }),
  output: toolResultSchema,
  run: () => ({ ok: true as const, value: { ok: true } }),
});
