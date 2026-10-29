/**
 * Catalog verbs with no CommandSpec body. Tea #invokeHostVerb handles
 * them locally — firing #commandSurface is a no-op.
 */
export const HOST_VERBS = ["compact", "quit", "new", "rename", "agentic", "background", "rewind", "undo", "permissions"] as const;

export function isHostVerb(verb: string): verb is (typeof HOST_VERBS)[number] {
  return (HOST_VERBS as readonly string[]).includes(verb);
}
