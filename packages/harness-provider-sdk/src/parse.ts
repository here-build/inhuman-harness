import { z } from "zod";

export function parseWith<T>(schema: z.ZodType<T>, value: unknown, context = "provider-sdk"): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  throw new Error(`${context}: ${path}${issue.message}`);
}
