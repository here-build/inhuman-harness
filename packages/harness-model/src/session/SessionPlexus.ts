import {
  DocumentContainer,
  serializeDocument,
  type SerializedDocument,
  type SerializedModelRow,
} from "@inhuman.tools/model";
import type { SessionAwareness } from "@inhuman.tools/plexus-expectations";

import { hydrateSessionRoot, SessionRoot } from "./SessionRoot.js";

export type SessionPlexusCreateOptions = {
  readonly sessionId?: string;
  readonly path?: string;
  readonly revision?: number;
  readonly clientId?: number;
  readonly meta?: Record<string, Record<string, unknown>>;
};

export type SessionPlexusBootstrapOptions = SessionPlexusCreateOptions;
export type SerializedSessionDocument = SerializedDocument;

function sessionDocumentGuid(id?: string): string | undefined {
  if (!id) return undefined;
  return id.startsWith("harness:session:") ? id : `harness:session:${id}`;
}

export class SessionDocument extends DocumentContainer<SessionRoot, SessionAwareness> {
  static override fromSnapshot(snapshot: SerializedDocument, sessionId?: string): SessionDocument {
    const doc = DocumentContainer.fromSnapshot<SessionRoot>(snapshot);
    const sessionDoc = new SessionDocument(doc.root, {
      guid: sessionDocumentGuid(sessionId ?? doc.root.sessionId),
      revision: snapshot.revision,
      meta: snapshot.meta,
    });
    if (sessionId && !sessionDoc.root.sessionId) {
      sessionDoc.root.sessionId = sessionId;
    }
    hydrateSessionRoot(sessionDoc.root);
    sessionDoc.markAllNodesCommitted();
    return sessionDoc;
  }

  static override fromNodeRows(
    rows: readonly SerializedModelRow[],
    options?: {
      readonly rootId?: string;
      readonly sessionId?: string;
      readonly revision?: number;
      readonly clientId?: number;
      readonly guid?: string;
      readonly meta?: Record<string, Record<string, unknown>>;
    },
  ): SessionDocument {
    const doc = DocumentContainer.fromNodeRows<SessionRoot>(rows, options);
    const resolvedSessionId = options?.sessionId ?? doc.root.sessionId;
    const sessionDoc = new SessionDocument(doc.root, {
      guid: options?.guid ?? sessionDocumentGuid(resolvedSessionId),
      revision: options?.revision ?? 0,
      clientId: options?.clientId,
      meta: options?.meta,
    });
    if (options?.sessionId && !sessionDoc.root.sessionId) {
      sessionDoc.root.sessionId = options.sessionId;
    }
    hydrateSessionRoot(sessionDoc.root);
    sessionDoc.markAllNodesCommitted();
    return sessionDoc;
  }

  static create(
    idOrProps?: string | SessionPlexusCreateOptions,
    pathOrOptions?: string | SessionPlexusCreateOptions | DocumentContainer<any, any> | unknown,
    maybeOptions?: SessionPlexusCreateOptions | DocumentContainer<any, any> | unknown,
  ): SessionDocument {
    let sessionId = "";
    let path = "";
    let docContainer: DocumentContainer<any, any> | undefined;
    let options: SessionPlexusCreateOptions | undefined;

    if (typeof idOrProps === "string") {
      sessionId = idOrProps;
      if (typeof pathOrOptions === "string") {
        path = pathOrOptions;
        if (maybeOptions instanceof DocumentContainer) {
          docContainer = maybeOptions;
        } else if (maybeOptions && typeof maybeOptions === "object") {
          options = maybeOptions as SessionPlexusCreateOptions;
        }
      } else if (pathOrOptions instanceof DocumentContainer) {
        docContainer = pathOrOptions;
      } else if (pathOrOptions && typeof pathOrOptions === "object") {
        options = pathOrOptions as SessionPlexusCreateOptions;
      }
    } else if (idOrProps && typeof idOrProps === "object") {
      sessionId = idOrProps.sessionId ?? "";
      path = idOrProps.path ?? "";
      options = idOrProps;
    }

    if (docContainer) {
      const root = new SessionRoot({ sessionId, path });
      hydrateSessionRoot(root);
      docContainer.hydrateFromSnapshot(serializeDocument(root));
      Object.setPrototypeOf(docContainer, SessionDocument.prototype);
      return docContainer as SessionDocument;
    }

    const root = new SessionRoot({ sessionId, path });
    hydrateSessionRoot(root);
    return new SessionDocument(root, {
      guid: sessionDocumentGuid(sessionId),
      revision: options?.revision,
      clientId: options?.clientId,
      meta: options?.meta,
    });
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
    const finish = (doc: SessionDocument): SessionDocument => {
      if (options?.readOnly === true) doc.readOnly = true;
      return doc;
    };
    if (source instanceof SessionDocument) return finish(source);
    if (source instanceof DocumentContainer) {
      if (!(source.root instanceof SessionRoot)) {
        const root = new SessionRoot();
        hydrateSessionRoot(root);
        source.hydrateFromSnapshot(serializeDocument(root));
      } else {
        hydrateSessionRoot(source.root as SessionRoot);
      }
      Object.setPrototypeOf(source, SessionDocument.prototype);
      return finish(source as SessionDocument);
    }
    if (source && typeof source === "object" && "root" in source && "revision" in source) {
      return finish(SessionDocument.fromSnapshot(source as SerializedDocument));
    }
    const root = new SessionRoot();
    hydrateSessionRoot(root);
    return finish(new SessionDocument(root, { clientId: options?.clientId }));
  }
}

export const SessionPlexus = SessionDocument;
export type SessionPlexus = SessionDocument;
