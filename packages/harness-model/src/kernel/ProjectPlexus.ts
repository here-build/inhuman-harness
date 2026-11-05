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

  static create(path: string, options?: ProjectPlexusCreateOptions): ProjectDocument {
    const root = new ProjectRoot({ path });
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
    source: ProjectDocument | SerializedDocument,
    _options?: { readOnly?: boolean; clientId?: number },
  ): ProjectDocument {
    const snapshot = source instanceof DocumentContainer ? source.toSnapshot() : source;
    const replica = ProjectDocument.fromSnapshot(snapshot);
    if (source instanceof DocumentContainer) {
      source.onPatch((batch) => {
        replica.applyPatchBatch(batch);
      });
    }
    return replica;
  }
}

export const ProjectPlexus = ProjectDocument;
export type ProjectPlexus = ProjectDocument;
