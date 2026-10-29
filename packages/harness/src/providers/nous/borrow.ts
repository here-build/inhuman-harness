/**
 * Token owner is the live Nous OIDC connection. Intern honor borrows after
 * that connection has been ensured. Source failure still mints intern (401,
 * not hang).
 *
 * Memo key is intern + current source so PEW ticks share one chain, while a
 * source A→B switch cannot reuse A's handshake. Kernel intern is keyed by
 * connection id only — changing the memo key is not enough; remint drops
 * the shared lease so the next ensure constructs against B.
 */
const SOURCE_SEP = "\u001f";

export function borrowedEnsureKey(internId: string, sourceId: string | null): string {
  return `${internId}${SOURCE_SEP}${sourceId ?? ""}`;
}

function internPrefix(internId: string): string {
  return `${internId}${SOURCE_SEP}`;
}

export function memoBorrowedEnsure<T>(
  memos: Map<string, Promise<T>>,
  internId: string,
  sourceId: string | null,
  ensureSource: (id: string) => Promise<unknown>,
  ensureIntern: () => Promise<T>,
  remintIntern: () => void | Promise<void> = () => undefined,
): Promise<T> {
  const key = borrowedEnsureKey(internId, sourceId);
  const hit = memos.get(key);
  if (hit !== undefined) return hit;
  const stale: Promise<T>[] = [];
  const prefix = internPrefix(internId);
  for (const [existing, pending] of memos) {
    if (existing === key || !existing.startsWith(prefix)) continue;
    stale.push(pending);
    memos.delete(existing);
  }
  const pending = (async () => {
    if (stale.length > 0) {
      await Promise.allSettled(stale);
      await remintIntern();
    }
    if (sourceId !== null) {
      try {
        await ensureSource(sourceId);
      } catch {
        /* source handshake failure still mints intern */
      }
    }
    return ensureIntern();
  })();
  memos.set(key, pending);
  return pending;
}
