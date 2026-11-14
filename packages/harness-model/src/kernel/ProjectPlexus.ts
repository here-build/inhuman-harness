/**
 * Path is the project identity.
 */
import {
  DocumentContainer,
  serializeDocument,
  type AwarenessShape,
  type SerializedDocument,
  type SerializedModelRow,
} from "@inhuman.tools/model";
import { nanoid } from "nanoid";

import { ProjectRoot } from "./ProjectRoot.js";

export const PROJECT_DOC_KIND = "harness:project";

export function mintProjectDocGuid(): string {
  return `${PROJECT_DOC_KIND}:${nanoid()}`;
}

export type ProjectPlexusCreateOptions = {
  readonly clientId?: number;
  readonly revision?: number;
};

export class ProjectDocument extends DocumentContainer<ProjectRoot, AwarenessShape> {
  static override fromSnapshot(snapshot: SerializedDocument): ProjectDocument {
    const doc = DocumentContainer.fromSnapshot<ProjectRoot>(snapshot);
    const projectDoc = new ProjectDocument(doc.root, { revision: snapshot.revision });
    projectDoc.markAllNodesCommitted();
    return projectDoc;
  }

  static override fromNodeRows(
    rows: readonly SerializedModelRow[],
    options?: {
      readonly rootId?: string;
      readonly revision?: number;
      readonly clientId?: number;
      readonly guid?: string;
      readonly meta?: Record<string, Record<string, unknown>>;
    },
  ): ProjectDocument {
    const doc = DocumentContainer.fromNodeRows<ProjectRoot>(rows, options);
    const projectDoc = new ProjectDocument(doc.root, {
      guid: options?.guid,
      revision: options?.revision ?? 0,
      clientId: options?.clientId,
      meta: options?.meta,
    });
    projectDoc.markAllNodesCommitted();
    return projectDoc;
  }

  static create(
    path: string,
    docOrOptions?: DocumentContainer<any, any> | ProjectPlexusCreateOptions | unknown,
  ): ProjectDocument {
    if (docOrOptions instanceof DocumentContainer) {
      if (!(docOrOptions.root instanceof ProjectRoot) || docOrOptions.root.path !== path) {
        const root = new ProjectRoot({ path });
        const doc = new ProjectDocument(root, { guid: docOrOptions.guid, revision: docOrOptions.revision });
        docOrOptions.hydrateFromSnapshot(doc.toSnapshot());
      }
      return ProjectDocument.connect(docOrOptions);
    }
    const root = new ProjectRoot({ path });
    const options =
      docOrOptions && typeof docOrOptions === "object" && !("root" in docOrOptions)
        ? (docOrOptions as ProjectPlexusCreateOptions)
        : undefined;
    return new ProjectDocument(root, { revision: options?.revision, clientId: options?.clientId });
  }

  static bootstrap(
    root: ProjectRoot,
    _documentId?: string,
    _doc?: unknown,
    options?: ProjectPlexusCreateOptions,
  ): ProjectDocument {
    return new ProjectDocument(root, { revision: options?.revision, clientId: options?.clientId });
  }

  static connect(
    source: ProjectDocument | DocumentContainer<any, any> | SerializedDocument | unknown,
    options?: { readonly readOnly?: boolean; readonly clientId?: number; readonly undo?: string },
  ): ProjectDocument {
    const finish = (doc: ProjectDocument): ProjectDocument => {
      if (options?.readOnly === true) doc.readOnly = true;
      return doc;
    };
    if (source instanceof ProjectDocument) return finish(source);
    if (source instanceof DocumentContainer) {
      if (!(source.root instanceof ProjectRoot)) {
        const root = new ProjectRoot();
        source.hydrateFromSnapshot(serializeDocument(root));
      }
      Object.setPrototypeOf(source, ProjectDocument.prototype);
      return finish(source as ProjectDocument);
    }
    if (source && typeof source === "object" && "root" in source && "revision" in source) {
      return finish(ProjectDocument.fromSnapshot(source as SerializedDocument));
    }
    return finish(new ProjectDocument(new ProjectRoot(), options));
  }
}

export const ProjectPlexus = ProjectDocument;
export type ProjectPlexus = ProjectDocument;
