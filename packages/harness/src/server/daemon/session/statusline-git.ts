/** Statusline git clock: `watchGit` on the session root, as a disposable. Null outside a repo. */
import { gitDirOf, watchGit } from "@inhuman.tools/statusline";

export function watchGitStatusline(root: string, onChange: () => void): Disposable | null {
  if (gitDirOf(root) == null) return null;
  const stop = watchGit(root, onChange);
  return { [Symbol.dispose]: stop };
}
