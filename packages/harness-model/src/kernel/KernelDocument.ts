import {
  DocumentContainer,
  serializeDocument,
  type SerializedDocument,
  type SerializedModelRow,
} from "@inhuman.tools/model";

import { hydrateKernelRoot, KernelRoot } from "./KernelRoot.js";
import type { KernelAwareness } from "./seat.js";

export const KERNEL_DOC_GUID = "harness:kernel";

export type KernelDocumentCreateOptions = {
  readonly clientId?: number;
  readonly revision?: number;
};

export class KernelDocument extends DocumentContainer<KernelRoot, KernelAwareness> {
  static override fromSnapshot(snapshot: SerializedDocument): KernelDocument {
    const doc = DocumentContainer.fromSnapshot<KernelRoot>(snapshot);
    const kernelDoc = new KernelDocument(doc.root, { guid: KERNEL_DOC_GUID, revision: snapshot.revision });
    hydrateKernelRoot(kernelDoc.root);
    kernelDoc.markAllNodesCommitted();
    return kernelDoc;
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
  ): KernelDocument {
    const doc = DocumentContainer.fromNodeRows<KernelRoot>(rows, options);
    const kernelDoc = new KernelDocument(doc.root, {
      guid: options?.guid ?? KERNEL_DOC_GUID,
      revision: options?.revision ?? 0,
      clientId: options?.clientId,
      meta: options?.meta,
    });
    hydrateKernelRoot(kernelDoc.root);
    kernelDoc.markAllNodesCommitted();
    return kernelDoc;
  }

  static create(root: KernelRoot = new KernelRoot(), options?: KernelDocumentCreateOptions): KernelDocument {
    const doc = new KernelDocument(root, {
      guid: KERNEL_DOC_GUID,
      revision: options?.revision,
      clientId: options?.clientId,
    });
    hydrateKernelRoot(doc.root);
    return doc;
  }

  static bootstrap(
    root: KernelRoot = new KernelRoot(),
    _documentId?: string,
    _doc?: unknown,
    options?: KernelDocumentCreateOptions,
  ): KernelDocument {
    return KernelDocument.create(root, options);
  }

  static connect(
    source: KernelDocument | DocumentContainer<any, any> | SerializedDocument | unknown,
    options?: { readonly readOnly?: boolean; readonly clientId?: number; readonly undo?: string },
  ): KernelDocument {
    const finish = (doc: KernelDocument): KernelDocument => {
      if (options?.readOnly === true) doc.readOnly = true;
      return doc;
    };
    if (source instanceof KernelDocument) return finish(source);
    if (source instanceof DocumentContainer) {
      if (!(source.root instanceof KernelRoot)) {
        const root = new KernelRoot();
        hydrateKernelRoot(root);
        source.hydrateFromSnapshot(serializeDocument(root));
      } else {
        const wasReadOnly = source.readOnly;
        if (wasReadOnly) source.readOnly = false;
        try {
          hydrateKernelRoot(source.root as KernelRoot);
        } finally {
          if (wasReadOnly) source.readOnly = true;
        }
      }
      Object.setPrototypeOf(source, KernelDocument.prototype);
      return finish(source as KernelDocument);
    }
    if (source && typeof source === "object" && "root" in source && "revision" in source) {
      return finish(KernelDocument.fromSnapshot(source as SerializedDocument));
    }
    return finish(KernelDocument.create(new KernelRoot(), options));
  }
}
