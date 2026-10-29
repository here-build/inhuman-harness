import { z } from "zod";

const findingEvidenceSchema = z.object({
  matched: z.string().optional(),
  raw: z.string().optional(),
  pattern: z.string().optional(),
  type: z.string().optional(),
});

export const findingSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  title: z.string(),
  description: z.string(),
  remediation: z.string().optional(),
  evidence: z.array(findingEvidenceSchema).optional(),
});

export const outputSchema = z.object({
  schema_version: z.literal(3),
  action: z.enum(["allow", "warn", "block"]),
  findings: z.array(findingSchema),
  bypass_honored: z.literal(false),
  policy_path_used: z.string().nullable().optional(),
});

export type TirithFinding = z.infer<typeof findingSchema>;
export type TirithOutput = z.infer<typeof outputSchema>;
