/**
 * Browser dial. No `node:`, no `ws`, no `Client`.
 * Side-effect import keeps every `@syncing` class the documents can name.
 */
import "@inhuman.tools/harness-model/register";

export {
  KERNEL_DOC_GUID,
  KernelPlexus,
  mintProjectDocGuid,
  PROJECT_DOC_KIND,
  ProjectPlexus,
  SessionPlexus,
} from "@inhuman.tools/harness-model";
export { publishRevalidationDemand } from "@inhuman.tools/plexus-expectations";

// The daemon's Yjs server speaks these frames too (`forwardPlexusAwareness` is among them).
export * from "./frames.js";
export * from "./awareness.js";

export {
  BLOB_CACHE_MAX_CHARS,
  BLOB_FAILURE_MS,
  createBlobCache,
  type BlobCache,
  type BlobCacheOptions,
  type BlobRequest,
} from "./blobs.js";
export { awarenessBytes, bindProviderAwareness } from "./plane.js";
export { bindJsonRpc, destroyProvider, detachProtocolAwareness, waitForSync } from "./rpc.js";
export type { JsonRpcPort } from "./rpc.js";
