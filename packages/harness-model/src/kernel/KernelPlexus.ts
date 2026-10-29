import { Plexus, type PlexusModel, type PlexusOptions } from "@here.build/plexus";
import invariant from "tiny-invariant";
import * as Y from "yjs";

import { hydrateKernelRoot, KernelRoot } from "./KernelRoot.js";
import type { KernelAwareness } from "./seat.js";

export const KERNEL_DOC_GUID = "harness:kernel";

export class KernelPlexus extends Plexus<KernelRoot, KernelAwareness> {
  static connect(doc: Y.Doc, options?: PlexusOptions): KernelPlexus {
    invariant(
      doc.guid === KERNEL_DOC_GUID,
      () => `KernelPlexus.connect: guid ${JSON.stringify(doc.guid)} is not ${KERNEL_DOC_GUID}`,
    );
    const plexus = super.connect(doc, options) as KernelPlexus;
    hydrateKernelRoot(plexus.root);
    return plexus;
  }

  static bootstrap(
    root: PlexusModel = new KernelRoot(),
    documentId: string = KERNEL_DOC_GUID,
    doc?: Y.Doc,
    options?: PlexusOptions,
  ): KernelPlexus {
    return super.bootstrap(root, documentId, doc ?? new Y.Doc({ guid: documentId }), options) as KernelPlexus;
  }
}
