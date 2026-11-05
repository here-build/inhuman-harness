/**
 * Free entities by default. Materialize only for wire / plane attach.
 */
import { SessionRoot } from "../../SessionRoot.js";

/** Free session root (CRDT fields only). */
export function attached(props: { sessionId: string; path: string }): SessionRoot {
  return new SessionRoot(props);
}
