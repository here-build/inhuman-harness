/**
 * Browser dial. No `node:`, no `ws`, no `Client`.
 * Side-effect import keeps every `@model` class the documents can name.
 */
import "@inhuman.tools/harness-model/register";

export {
  KERNEL_DOC_GUID,
  KernelDocument,
  mintProjectDocGuid,
  PROJECT_DOC_KIND,
  ProjectDocument,
  publishKernelSeat,
  SessionDocument,
} from "@inhuman.tools/harness-model";
export { publishRevalidationDemand } from "@inhuman.tools/expectations";

export * from "./frames.js";
export * from "./awareness.js";
export * from "./doc.js";

export {
  BLOB_CACHE_MAX_CHARS,
  BLOB_FAILURE_MS,
  createBlobCache,
  type BlobCache,
  type BlobCacheOptions,
  type BlobRequest,
} from "./blobs.js";
export { bindRoomAwareness } from "./plane.js";
export {
  bindJsonRpc,
  bindTextFrames,
  destroyRoomConnection,
  detachLocalPresence,
  RoomConnection,
  waitForSync,
  type JsonRpcPort,
  type RoomConnectionOptions,
  type TextFrameSource,
} from "./rpc.js";
