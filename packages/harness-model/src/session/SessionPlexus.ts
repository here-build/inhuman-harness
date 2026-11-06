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
    source: SessionDocument | DocumentContainer<any, any> | SerializedDocument | unknown,
    options?: { readonly readOnly?: boolean; readonly clientId?: number; readonly undo?: string },
  ): SessionDocument {
    if (source instanceof DocumentContainer) {
      let replica: SessionDocument;
      if (source.root instanceof SessionRoot) {
        replica = SessionDocument.fromSnapshot(source.toSnapshot());
      } else {
        const root = new SessionRoot();
        hydrateSessionRoot(root);
        replica = new SessionDocument(root, { clientId: options?.clientId });
        source.hydrateFromSnapshot(replica.toSnapshot());
      }
      let syncing = false;
      source.onPatch((batch) => {
        if (syncing) return;
        syncing = true;
        try {
          try {
            replica.applyPatchBatch(batch);
          } catch {
            replica.hydrateFromSnapshot(source.toSnapshot());
          }
        } finally {
          syncing = false;
        }
      });
      source.on("update", (update, origin) => {
        if (syncing || origin === replica) return;
        syncing = true;
        try {
          replica.applyUpdate(update, origin);
        } finally {
          syncing = false;
        }
      });
      if (!options?.readOnly) {
        replica.onPatch((batch) => {
          if (syncing) return;
          syncing = true;
          try {
            try {
              source.applyPatchBatch(batch);
            } catch {
              source.hydrateFromSnapshot(replica.toSnapshot(), replica);
            }
          } finally {
            syncing = false;
          }
        });
      }
      return replica;
    }
    if (source && typeof source === "object" && "root" in source && "revision" in source) {
      return SessionDocument.fromSnapshot(source as SerializedDocument);
    }
    const root = new SessionRoot();
    hydrateSessionRoot(root);
    return new SessionDocument(root, { clientId: options?.clientId });
  }
}

export const SessionPlexus = SessionDocument;
export type SessionPlexus = SessionDocument;
