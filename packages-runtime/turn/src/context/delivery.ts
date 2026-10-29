/**
 * Pure call-delivery projection for history.
 * Acceptance, leases, and settlement stay in agent-calls.
 */
import type { CatalogEntry } from "../tool-catalog/index.js";

export type DeliveryCatalog = {
  catalogEntry(wireName: string): CatalogEntry | undefined;
};

/** Omit / turn catalog visibility. Not a lease or marker. */
export function usesGenericSilentProjection(call: { readonly name: string }, catalog: DeliveryCatalog): boolean {
  const meta = catalog.catalogEntry(call.name)?.packMeta;
  return meta?.kind === "bot-call" && (meta.show === "omit" || meta.show === "turn");
}
