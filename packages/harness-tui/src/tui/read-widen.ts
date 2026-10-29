/**
 * Extra-root read folder suggestion, as an explicit question: "Treat <folder> as part of this session?"
 * One directory up, offered, never installed. Evidence is a same-parent sibling (an existing session
 * root or an in-flight read). Disjoint trees stay a set — this is not LCA. A yes adds a session read
 * root (`SessionRoot.addReadRoot`): reads under it follow the in-workspace rules, and block rules
 * still block. A single outside read is never remembered, and writes are never a root.
 */
import { workspaceRelative } from "@inhuman.tools/harness-model";

const HOME_TOP = new Set(["Users", "home", "Volumes", "private"]);

export type FileReadWiden = {
  readonly path: string;
  readonly label: string;
};

/** One directory up. Undefined at `.` / `/` / `$HOME` / a volume root. */
export function fileReadParent(prepared: string): string | undefined {
  if (prepared === "." || prepared === "/" || prepared === "") return undefined;
  const cut = prepared.lastIndexOf("/");
  if (cut <= 0) return undefined;
  const parent = prepared.slice(0, cut);
  if (parent === "/" || parent === "" || !parent.startsWith("/")) return undefined;
  const segs = parent.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  if (segs.length === 2 && HOME_TOP.has(segs[0]!)) return undefined;
  return parent;
}

export function fileReadWidenLabel(rootPath: string, parent: string): string {
  const rel = workspaceRelative(rootPath, parent);
  return rel.length > 0 && rel.length < parent.length ? rel : parent;
}

/**
 * Suggest `parent(prepared)` when another observed extra-root read shares
 * that parent (or *is* that parent). `observed` is allowlist keys plus
 * other in-flight read paths — not denials.
 */
export function fileReadWiden(
  rootPath: string,
  prepared: string,
  observed: readonly string[],
): FileReadWiden | undefined {
  const parent = fileReadParent(prepared);
  if (parent === undefined) return undefined;
  const sibling = observed.some((path) => path !== prepared && (path === parent || fileReadParent(path) === parent));
  if (!sibling) return undefined;
  return { path: parent, label: fileReadWidenLabel(rootPath, parent) };
}
