/**
 * Identity of a picture on a user turn. The bytes live in a file beside
 * the session document, keyed by `id`. This record is what syncs.
 */
import { z } from "zod";

const visualSize = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const userVisualIdentity = z.object({
  id: z.string().min(1),
  mime: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  resizedFrom: visualSize.nullable(),
  sourcePath: z.string().nullable(),
});

const userVisualList = z.array(userVisualIdentity);

export type UserVisualSize = z.infer<typeof visualSize>;
export type UserVisualIdentity = z.infer<typeof userVisualIdentity>;

/** Blank, legacy, and corrupt text are no pictures. */
export function parseUserVisuals(text: string | null | undefined): readonly UserVisualIdentity[] {
  const trimmed = (text ?? "").trim();
  if (trimmed === "" || trimmed === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const result = userVisualList.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function userVisualsJson(visuals: readonly UserVisualIdentity[]): string {
  return JSON.stringify(visuals);
}
