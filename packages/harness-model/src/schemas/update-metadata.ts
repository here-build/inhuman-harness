import { z } from "zod";

export const updateMetadataArgsSchema = z
  .object({
    current_turn_title: z.unknown().optional(),
    current_turn_description: z.unknown().optional(),
  })
  .passthrough();
