import { DocumentContainer, type SerializedDocument } from "@inhuman.tools/model";
import type { SessionAwareness } from "@inhuman.tools/plexus-expectations";

import { hydrateSessionRoot, SessionRoot } from "./SessionRoot.js";

export type SessionPlexusCreateOptions = {
  readonly sessionId?: string;
  readonly path?: string;
  readonly revision?: number;
  readonly clientId?: number;
  readonly meta?: Record<string, Record<string, string>>;
};

export type SessionPlexusBootstrapOptions = SessionPlexusCreateOptions;
export type SerializedSessionDocument = SerializedDocument;

export class SessionDocument extends DocumentContainer<SessionRoot, SessionAwareness> {
  static override fromSnapshot(snapshot: SerializedDocument, sessionId?: string): SessionDocument {
    const doc = DocumentContainer.fromSnapshot<SessionRoot>(snapshot);
    const sessionDoc = new SessionDocument(doc.root, { revision: snapshot.revision, meta: snapshot.meta });
    if (sessionId && !sessionDoc.root.sessionId) {
      sessionDoc.root.sessionId = sessionId;
    }
    hydrateSessionRoot(sessionDoc.root);
    return sessionDoc;
  }

  static create(
    idOrProps?: string | SessionPlexusCreateOptions,
    pathOrOptions?: string | SessionPlexusCreateOptions,
    maybeOptions?: SessionPlexusCreateOptions,
  ): SessionDocument {
    let sessionId = "";
    let path = "";
    let options: SessionPlexusCreateOptions | undefined;

    if (typeof idOrProps === "string") {
      sessionId = idOrProps;
      if (typeof pathOrOptions === "string") {
        path = pathOrOptions;
        options = maybeOptions;
      } else if (pathOrOptions && typeof pathOrOptions === "object") {
        options = pathOrOptions;
      }
    } else if (idOrProps && typeof idOrProps === "object") {
      sessionId = idOrProps.sessionId ?? "";
      path = idOrProps.path ?? "";
      options = idOrProps;
    }

    const root = new SessionRoot({ sessionId, path });
    hydrateSessionRoot(root);
    return new SessionDocument(root, { revision: options?.revision, clientId: options?.clientId, meta: options?.meta });
  }

  static bootstrap(
    idOrRoot?: string | SessionRoot | SessionPlexusBootstrapOptions,
    options?: SessionPlexusBootstrapOptions,
  ): SessionDocument {
    if (idOrRoot instanceof SessionRoot) {
      return new SessionDocument(idOrRoot, options);
    }
    return SessionDocument.create(idOrRoot, options);
  }

  static connect(
    source: SessionDocument | SerializedDocument | unknown,
    options?: { readonly readOnly?: boolean; readonly clientId?: number; readonly undo?: string },
  ): SessionDocument {
    if (source instanceof DocumentContainer) {
      const replica = SessionDocument.fromSnapshot(source.toSnapshot());
      source.onPatch((batch) => {
        replica.applyPatchBatch(batch);
      });
      return replica;
    }
    if (source && typeof source === "object" && "root" in source && "revision" in source) {
      return SessionDocument.fromSnapshot(source as SerializedDocument);
    }
    const root = new SessionRoot();
    hydrateSessionRoot(root);
    return new SessionDocument(root, { clientId: options?.clientId });
  }

  loadEntity(uuid: string): unknown {
    return this.getNode(uuid);
  }
}

export const SessionPlexus = SessionDocument;
export type SessionPlexus = SessionDocument;
