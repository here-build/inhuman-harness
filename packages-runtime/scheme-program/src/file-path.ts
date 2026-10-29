/**
 * Path stamp on a `read_file` string. Identity-keyed: substring/append mint a
 * new `AString` and drop it. `withProvenance` clones the same box — copy the
 * stamp onto the clone. Not provenance.
 */
import { AString } from "@here.build/arrival/reflect-internals";

const paths = new WeakMap<AString, string>();

const originalWithProvenance = AString.prototype.withProvenance;
Object.defineProperty(AString.prototype, "withProvenance", {
  value(this: AString, p: ReadonlySet<number>) {
    const next = originalWithProvenance.call(this, p);
    const path = paths.get(this);
    if (path !== undefined && next instanceof AString) paths.set(next, path);
    return next;
  },
});

export function stampFilePath(value: AString, path: string): AString {
  paths.set(value, path);
  return value;
}

export function filePathOf(value: unknown): string | undefined {
  return value instanceof AString ? paths.get(value) : undefined;
}
