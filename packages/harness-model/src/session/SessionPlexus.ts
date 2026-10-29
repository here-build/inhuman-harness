import { Plexus, type PlexusOptions } from "@here.build/plexus";
import type { SessionAwareness as PewSessionAwareness } from "@inhuman.tools/plexus-expectations";
import * as Y from "yjs";

import { hydrateSessionRoot, SessionRoot } from "./SessionRoot.js";

export class SessionPlexus extends Plexus<SessionRoot, PewSessionAwareness> {
  /** Attach a rooted session doc. The caller is a replica — never mints a root. */
  static connect(doc: Y.Doc, options?: PlexusOptions): SessionPlexus {
    const plexus = super.connect(doc, options) as SessionPlexus;
    hydrateSessionRoot(plexus.root);
    return plexus;
  }

  /**
   * Mint a session root. Throws if this doc is already bound — use {@link connect}.
   * `sessionId` is the bare id. `doc` is the rehydrate image; omit to mint.
   */
  static create(sessionId: string, path = "", doc?: Y.Doc): SessionPlexus {
    const document = doc ?? new Y.Doc({ guid: `harness:session:${sessionId}` });
    return super.bootstrap(new SessionRoot({ sessionId, path }), document.guid, document, {
      undo: "stub",
    }) as SessionPlexus;
  }
}
