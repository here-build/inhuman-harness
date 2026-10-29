import { join } from "node:path";

import type { KernelRoot } from "@inhuman.tools/harness-model";

import { resolveCompactStrategyPath } from "../../../defaults/index.js";

/** Unresolvable spec is omitted. `config.json` stays in the watch set; a fix re-reflects. */
function tryPushStrategyPath(files: string[], spec: string, root: string): void {
  try {
    files.push(resolveCompactStrategyPath(spec, root));
  } catch {
    return;
  }
}

export function watchPaths(root: string, into: KernelRoot): string[] {
  const files = [
    join(root, "config.json"),
    join(root, "kv.json"),
    join(root, "grants.json"),
    join(root, "package.json"),
    join(root, "package-lock.json"),
    join(root, "compact.scm"),
  ];
  tryPushStrategyPath(files, into.compactStrategy, root);
  tryPushStrategyPath(files, into.autoModeClassifier, root);
  const statusline = into.statusline.trim();
  if (statusline !== "" && !statusline.startsWith("(")) {
    tryPushStrategyPath(files, statusline, root);
  }
  for (const plugin of Object.values(into.plugins)) {
    if (plugin.rootPath !== "") files.push(join(plugin.rootPath, "plugin.json"));
  }
  for (const command of Object.values(into.commands)) {
    if (command.source !== "") files.push(command.source);
  }
  return files;
}
