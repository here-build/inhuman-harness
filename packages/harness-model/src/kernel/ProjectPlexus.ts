/**
 * Path is the project identity.
 */
import { DocumentContainer, type AwarenessShape, type SerializedDocument } from "@inhuman.tools/model";
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
    options?: { readOnly?: boolean; clientId?: number },
  ): ProjectDocument {
    if (source instanceof DocumentContainer) {
      let replica: ProjectDocument;
      if (source.root instanceof ProjectRoot) {
        replica = ProjectDocument.fromSnapshot(source.toSnapshot());
      } else {
        replica = new ProjectDocument(new ProjectRoot(), options);
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
      return ProjectDocument.fromSnapshot(source as SerializedDocument);
    }
    return new ProjectDocument(new ProjectRoot(), options);
  }
}

export const ProjectPlexus = ProjectDocument;
export type ProjectPlexus = ProjectDocument;
