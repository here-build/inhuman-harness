import * as z from "zod";

/** Per-server entry: stdio OR http. `tools` is the optional per-server tool allowlist —
 *  absent means every tool binds; present means ONLY these, naming a missing tool is a
 *  loud config error (typo guard). */
export const mcpServerEntry = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  tools: z.array(z.string().min(1)).optional(),
});

export const catalogConfig = z.object({
  detail: z.enum(["full", "summary"]).optional(),
  summaryText: z.string().min(1).optional(),
});

export const mcpServersFile = z.object({
  /** Key is the server slug. An EMPTY slug binds this server's tools by their BARE
   *  names (single-server shape; see bind.ts). */
  mcpServers: z.record(z.string(), mcpServerEntry),
  /** Per-eval wall-clock budget in ms (H-1). Absent ⇒ manifold-tool's default. */
  evalTimeoutMs: z.number().int().positive().optional(),
  /** Catalog-detail parity harness. Absent ⇒ "full" (byte-identical catalog). */
  catalog: catalogConfig.optional(),
  /** Branded attestation knob. Absent ⇒ "available". */
  attestation: z.enum(["off", "available", "required"]).optional(),
  /** Observation rendering. Absent ⇒ "braces". "sexpr" escapes back to constructor form. */
  rendering: z.enum(["braces", "sexpr"]).optional(),
  /** Observation size budget in chars. Absent ⇒ render-observation.ts's 20k. */
  observation: z
    .object({
      maxTotalChars: z.number().int().positive().optional(),
    })
    .optional(),
  /** Opt-in metadata prompt-fields (focused-reasoning substrate; enabled per-deploy
   *  when it helps, dead weight on strong models). */
  promptFields: z.object({ intent: z.boolean().optional(), successCriteria: z.boolean().optional() }).optional(),
  /** Type-hints whole-feature kill switch. Absent ⇒ "telemetry" (safe default; measure,
   *  don't render). Per-code demotion is a code edit, never a config knob. */
  typeHints: z.enum(["off", "telemetry", "on-error"]).optional(),
});
