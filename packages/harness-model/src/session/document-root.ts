import type { Model } from "@inhuman.tools/model";

import type { SessionRoot } from "./SessionRoot.js";

export function documentRoot(entity: Model): SessionRoot | undefined {
  const root = entity.container?.container?.root;
  if (root != null && (root.constructor.name === "SessionRoot" || "sessionId" in root)) {
    return root as SessionRoot;
  }

  let curr: unknown = entity;
  const visited = new Set<unknown>();
  while (curr != null && typeof curr === "object" && !visited.has(curr)) {
    visited.add(curr);
    if ((curr as any).constructor.name === "SessionRoot" || ("sessionId" in curr && "head" in curr)) {
      return curr as SessionRoot;
    }
    if ("turnTail" in curr && (curr as any).turnTail != null && !visited.has((curr as any).turnTail)) {
      const tailRoot = documentRoot((curr as any).turnTail as Model);
      if (tailRoot) return tailRoot;
    }
    curr = (curr as Model).parent;
  }
  return undefined;
}
