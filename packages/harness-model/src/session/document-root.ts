/**
 * The root the document was bootstrapped with.
 *
 * `Agent.head` owns the head turn, so `rootAncestor` from that turn reaches
 * the session. Replacing head orphans the previous turn; `turnTail` and `tip`
 * keep it in the document, and license on that turn still uses this lookup.
 * `Agent.parent` is the recipe link and shadows the ownership getter.
 */
import type { PlexusModel } from "@here.build/plexus";
import { docPlexus } from "@here.build/plexus/internals";

export function documentRoot(entity: PlexusModel): PlexusModel | undefined {
  const doc = entity.__doc__;
  if (doc == null) return undefined;
  return docPlexus.get(doc)?.root;
}
