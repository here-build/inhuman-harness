/**
 * The TUI and the web app are dependencies loaded on demand. A command loads its shell when it runs,
 * so `inhuman daemon stop` and `inhuman mcp list` never pay for either. A shell that is not installed
 * becomes an install hint; any other failure to load, a dependency of an installed shell included,
 * keeps its stack: that is a broken install, not a missing shell.
 */
import type { ShellContext } from "./context.js";

export type ShellPackage = {
  /** What the user calls it in the hint: "TUI shell". */
  readonly label: string;
  /** The module handed to `import()`, subpath included. */
  readonly specifier: string;
};

/** `@scope/name/sub` is `@scope/name`; `name/sub` is `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/**
 * Node names the package, not the subpath, when it finds none: importing `@scope/web/server` fails with
 * "Cannot find package '@scope/web' imported from ...". A message that names any other module, such as a
 * file inside an installed shell or a package the shell itself needs, is not a missing shell.
 */
export function isShellMissing(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as NodeJS.ErrnoException;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  const named = /^Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1];
  return named === specifier || named === packageNameOf(specifier);
}

/** The loaded shell, or `undefined` after one stderr line when the shell is not installed. */
export async function importShell<T>(
  context: Pick<ShellContext, "writeErr">,
  shell: ShellPackage,
  load: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if (!isShellMissing(error, shell.specifier)) throw error;
    context.writeErr(`inhuman: the ${shell.label} is not installed — add ${packageNameOf(shell.specifier)}`);
    return undefined;
  }
}
