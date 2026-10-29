/**
 * Self-protection: the agent must not rewrite the gate that judges it. The floor is pure and does
 * not know the home directory, so the host adds the absolute locations the gates load from to
 * `write_block`. Only those locations: a repo file that merely shares a name (`authorize.scm`,
 * `policy.json`, a source dir called `.harness`) stays an ordinary project file.
 *
 * - `<home>/.harness`: kernel root (`policy.json`, `kv.json`, classifier `.scm` programs).
 * - `<home>/.inhuman` (or `$INHUMAN_HOME`): home config and bots.
 * - `$PI_CODING_AGENT_DIR` or `<home>/.pi/agent`: pi's `policy-pi.json` and `policy-pi-authorize.scm`.
 * `<root>/.pi/policy-pi.json` is project-relative and lives in the static floor.
 */
import { homedir } from "node:os";
import nodePath from "node:path";

export function selfProtectedRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const roots = [nodePath.join(home, ".harness"), nodePath.join(home, ".inhuman")];
  const inhuman = env.INHUMAN_HOME?.trim();
  if (inhuman !== undefined && inhuman !== "") roots.push(inhuman);
  const pi = env.PI_CODING_AGENT_DIR?.trim();
  roots.push(pi !== undefined && pi !== "" ? pi : nodePath.join(home, ".pi", "agent"));
  return roots.filter((root) => nodePath.isAbsolute(root));
}

/**
 * Document with the session's read roots ("Treat <folder> as part of this session?" answered yes)
 * appended to `read_file`, so reads under a root follow the in-workspace rules. Block rules still
 * block. Writes are never a root. A document with no read cluster passes through.
 */
export function withReadRoots(document: unknown, roots: readonly string[]): unknown {
  if (roots.length === 0 || document === null || typeof document !== "object" || Array.isArray(document)) {
    return document;
  }
  const doc = document as { read_file?: unknown };
  if (!Array.isArray(doc.read_file)) return document;
  return { ...doc, read_file: [...(doc.read_file as unknown[]), ...roots] };
}

/** Document with the absolute gate locations appended to `write_block`. Non-objects pass through. */
export function withSelfProtection(document: unknown, roots: readonly string[] = selfProtectedRoots()): unknown {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return document;
  const doc = document as { write_block?: unknown; write_file?: unknown };
  // A document with no write cluster asks for every write; adding a block list would turn that into deny-by-miss.
  if (doc.write_block === undefined && doc.write_file === undefined) return document;
  const existing = Array.isArray(doc.write_block) ? (doc.write_block as unknown[]) : [];
  return { ...doc, write_block: [...existing, ...roots] };
}
