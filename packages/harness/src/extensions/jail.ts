import { resolve } from "node:path";

/** Resolve `spec` inside `root`. Parent traversal → `null`. Does not follow realpath. */
export function jailedInside(root: string, spec: string): string | null {
  const file = resolve(root, spec);
  const inside = resolve(root);
  const prefix = inside.endsWith("/") ? inside : `${inside}/`;
  if (file !== inside && !file.startsWith(prefix)) return null;
  return file;
}
