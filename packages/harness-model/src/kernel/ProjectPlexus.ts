/**
 * Path is the project identity.
 */
import { DocumentContainer, serializeDocument, type AwarenessShape, type SerializedDocument } from "@inhuman.tools/model";
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
    return new ProjectDocument(doc.root, { revision: snapshot.revision });
  }

  static create(path: string, docOrOptions?: DocumentContainer<any, any> | ProjectPlexusCreateOptions | unknown): ProjectDocument {
    const root = new ProjectRoot({ path });
    if (docOrOptions instanceof DocumentContainer) {
      const doc = new ProjectDocument(root);
      docOrOptions.hydrateFromSnapshot(doc.toSnapshot());
      return ProjectDocument.connect(docOrOptions);
    }
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
    if (source instanceof ProjectDocument) return source;
    if (source instanceof DocumentContainer) {
      if (!(source.root instanceof ProjectRoot)) {
        const root = new ProjectRoot();
        source.hydrateFromSnapshot(serializeDocument(root));
      }
      Object.setPrototypeOf(source, ProjectDocument.prototype);
      return source as ProjectDocument;
    }
    if (source && typeof source === "object" && "root" in source && "revision" in source) {
      return ProjectDocument.fromSnapshot(source as SerializedDocument);
    }
    return new ProjectDocument(new ProjectRoot(), options);
  }
}

export const ProjectPlexus = ProjectDocument;
export type ProjectPlexus = ProjectDocument;
