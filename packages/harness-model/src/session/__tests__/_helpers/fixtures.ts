/**
 * Free entities by default. Materialize only for CRDT wire / plane attach.
 * Determinism: `resetLocalIDs()` + fixed creation order — never UUID literals.
 */
import { SessionRoot } from "../../SessionRoot.js";

/** Free session root (CRDT fields only). */
export function attached(props: { sessionId: string; path: string }): SessionRoot {
  return new SessionRoot(props);
}
