import { z } from "zod";

/**
 * Opaque process identity. There is no pid field: pid reuse is not ownership.
 */
export const processKindSchema = z.enum(["hypervisor", "yjs", "runtime"]);
export type ProcessKind = z.infer<typeof processKindSchema>;

export const processIdentitySchema = z
  .object({
    kind: processKindSchema,
    id: z.string().trim().min(1),
  })
  .strict();
export type ProcessIdentity = z.infer<typeof processIdentitySchema>;

export const epochSchema = z.number().int().nonnegative();
export type Epoch = z.infer<typeof epochSchema>;

export const generationSchema = z.number().int().nonnegative();
export type Generation = z.infer<typeof generationSchema>;

/**
 * Four clocks the rest of the protocol fences with:
 * hypervisor/process identity, server epoch, runtime generation, connection epoch.
 * Reconnect of a live owner advances connection epoch only.
 */
export const supervisionIdentitySchema = z
  .object({
    hypervisor: processIdentitySchema,
    process: processIdentitySchema,
    serverEpoch: epochSchema,
    runtimeGeneration: generationSchema,
    connectionEpoch: epochSchema,
  })
  .strict()
  .superRefine((identity, ctx) => {
    if (identity.hypervisor.kind !== "hypervisor") {
      ctx.addIssue({
        code: "custom",
        message: "hypervisor identity kind must be hypervisor",
        path: ["hypervisor", "kind"],
      });
    }
  });
export type SupervisionIdentity = z.infer<typeof supervisionIdentitySchema>;
