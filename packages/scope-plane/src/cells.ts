import type { CellKind } from "./schema.js";

export type Cell = string | number | boolean;

export type Row = Readonly<Record<string, Cell>>;

export class ScopeMissing extends Error {
  readonly scopeId: string;

  constructor(scopeId: string) {
    super(`scope missing: ${scopeId}`);
    this.name = "ScopeMissing";
    this.scopeId = scopeId;
  }
}

export class ScopeCycle extends Error {
  readonly scopeId: string;

  constructor(scopeId: string) {
    super(`scope cycle at ${scopeId}`);
    this.name = "ScopeCycle";
    this.scopeId = scopeId;
  }
}

export class ScopeKey extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeKey";
  }
}

/** Composite row id. Scope ids and parts must not contain U+0000. */
export function pairId(scopeId: string, part: string): string {
  if (scopeId.includes("\0") || part.includes("\0")) {
    throw new ScopeKey("scope id and key must not contain NUL");
  }
  return `${scopeId}\0${part}`;
}

export function text(row: Row | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

export function emptyToNull(value: string | null): string | null {
  return value == null || value === "" ? null : value;
}

export function num(row: Row | undefined, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function flag(row: Row | undefined, key: string): boolean | null {
  const value = row?.[key];
  return typeof value === "boolean" ? value : null;
}

export function coerceCell(kind: CellKind, value: unknown): Cell | undefined {
  if (value == null) return undefined;
  if (kind === "string") return typeof value === "string" ? value : undefined;
  if (kind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}
