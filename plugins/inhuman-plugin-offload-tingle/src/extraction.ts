/**
 * Citation validation, fact revision, and bounded pack eligibility for memory store.
 */
import type { CitedPack, FactRow, SourceRef, SourceSlice } from "./schemas/memory.js";

export const PACK_TOKEN_CEILING = 800;

export function refKey(ref: SourceRef): string {
  return `${ref.sessionId}:${ref.turnId}:${ref.completionId}:${ref.entityId}:${ref.field}:${ref.start}:${ref.end}`;
}

export function retainedRefKeys(slices: readonly SourceSlice[]): Set<string> {
  return new Set(slices.map((slice) => refKey(slice.ref)));
}

export function citationsSupported(citations: readonly SourceRef[], allowed: ReadonlySet<string>): boolean {
  if (citations.length === 0) return false;
  return citations.every((ref) => allowed.has(refKey(ref)));
}

export function filterPromotableFacts<T extends Omit<FactRow, "id" | "episodeId" | "recordedAt">>(
  facts: readonly T[],
  allowed: ReadonlySet<string>,
): T[] {
  return facts.filter((fact) => citationsSupported(fact.citations, allowed));
}

export function validatePack(
  pack: CitedPack,
  allowed: ReadonlySet<string>,
  tokenCeiling = PACK_TOKEN_CEILING,
): CitedPack | null {
  if (pack.tokenCount > tokenCeiling) return null;
  const items = pack.items.filter((item) => item.invalidAt == null && citationsSupported(item.citations, allowed));
  if (items.length === 0) return null;
  const tokenCount = items.reduce((sum, item) => sum + Math.ceil(item.snippet.length / 4), 0);
  if (tokenCount > tokenCeiling) return null;
  return { ...pack, items, tokenCount };
}
