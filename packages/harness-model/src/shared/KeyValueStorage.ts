/**
 * Apply kv-set / kv-clear onto a bag. Bags are independent records.
 * A new session copies `{...kernel, ...project}` once at mint — not a live
 * overlay, so kv/clear on session cannot reveal a parent bag. SessionDaemon
 * Session kv-set of model/connection stays local unless the caller passes
 * remember (/model, /connect). Other keys still write through.
 * Permission-mode last-choice is `defaultPermissionMode`, not a kv key.
 */
import type { KvProposal } from "./residual.js";

export function applyKv(values: Record<string, string>, proposals: readonly KvProposal[]): void {
  for (const proposal of proposals) {
    if (proposal.form === "kv-set") values[proposal.key] = proposal.value;
    else delete values[proposal.key];
  }
}

/** Mint-time snapshot. Project wins on collision. */
export function sessionMintKvs(kernel: Record<string, string>, project: Record<string, string>): KvProposal[] {
  return Object.entries({ ...kernel, ...project }).map(([key, value]) => ({
    form: "kv-set",
    key,
    value,
  }));
}

/** Mint-time snapshot of the per-connection model index. Project wins on collision. */
export function sessionMintLastUsedConnectionModel(
  kernel: Readonly<Record<string, string>>,
  project: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...kernel, ...project };
}
