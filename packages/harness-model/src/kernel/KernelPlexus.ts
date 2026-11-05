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
    source: KernelDocument | SerializedDocument,
    _options?: { readOnly?: boolean; clientId?: number },
  ): KernelDocument {
    const snapshot = source instanceof DocumentContainer ? source.toSnapshot() : source;
    const replica = KernelDocument.fromSnapshot(snapshot);
    if (source instanceof DocumentContainer) {
      source.onPatch((batch) => {
        replica.applyPatchBatch(batch);
      });
    }
    return replica;
  }
}

export const KernelPlexus = KernelDocument;
export type KernelPlexus = KernelDocument;
