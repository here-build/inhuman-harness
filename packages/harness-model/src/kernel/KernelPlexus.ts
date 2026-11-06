import { DocumentContainer, type SerializedDocument } from "@inhuman.tools/model";

import { hydrateKernelRoot, KernelRoot } from "./KernelRoot.js";
import type { KernelAwareness } from "./seat.js";

export const KERNEL_DOC_GUID = "harness:kernel";

export type KernelPlexusCreateOptions = {
  readonly clientId?: number;
  readonly revision?: number;
};

export class KernelDocument extends DocumentContainer<KernelRoot, KernelAwareness> {
  static override fromSnapshot(snapshot: SerializedDocument): KernelDocument {
    const doc = DocumentContainer.fromSnapshot<KernelRoot>(snapshot);
    const kernelDoc = new KernelDocument(doc.root, { revision: snapshot.revision });
    hydrateKernelRoot(kernelDoc.root);
    return kernelDoc;
  }

  static create(root: KernelRoot = new KernelRoot(), options?: KernelPlexusCreateOptions): KernelDocument {
    const doc = new KernelDocument(root, { revision: options?.revision, clientId: options?.clientId });
    hydrateKernelRoot(doc.root);
    return doc;
  }

  static bootstrap(
    root: KernelRoot = new KernelRoot(),
    _documentId?: string,
    _doc?: unknown,
    options?: KernelPlexusCreateOptions,
  ): KernelDocument {
    return KernelDocument.create(root, options);
  }

  static connect(
    source: KernelDocument | DocumentContainer<any, any> | SerializedDocument | unknown,
    options?: { readOnly?: boolean; clientId?: number },
  ): KernelDocument {
    if (source instanceof DocumentContainer) {
      let replica: KernelDocument;
      if (source.root instanceof KernelRoot) {
        replica = KernelDocument.fromSnapshot(source.toSnapshot());
      } else {
        replica = KernelDocument.create(new KernelRoot(), options);
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
      return KernelDocument.fromSnapshot(source as SerializedDocument);
    }
    return KernelDocument.create(new KernelRoot(), options);
  }
}

export const KernelPlexus = KernelDocument;
export type KernelPlexus = KernelDocument;
