import { z } from "zod";

export const workerBootSchema = z
  .object({
    kernel: z.string(),
    path: z.string(),
    sessionId: z.string().optional(),
    restore: z.boolean().optional(),
    draft: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    connection: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

export type WorkerBoot = z.infer<typeof workerBootSchema>;
