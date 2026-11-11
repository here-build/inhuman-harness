export const KERNEL_SCOPE_ID = "kernel" as const;

export function projectScopeId(canonicalPath: string): string {
  return `project:${canonicalPath}`;
}

/**
 * Single-column string composite primary key safe for both SQLite and PostgreSQL/ElectricSQL.
 * Rejects NUL (`\0`) bytes because PostgreSQL `TEXT` forbids `0x00`.
 */
export function rowPairId(ownerId: string, itemId: string): string {
  if (ownerId.includes("\0") || itemId.includes("\0")) {
    throw new Error("Composite row key parts must not contain NUL bytes");
  }
  return JSON.stringify([ownerId, itemId]);
}

export function splitRowPairId(id: string): readonly [string, string] | null {
  if (!id.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(id);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // not a pairId tuple
  }
  return null;
}
