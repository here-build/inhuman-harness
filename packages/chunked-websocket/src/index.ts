// Default entry point — wire-format primitives.
//
// Most consumers want one of the higher-level adapters:
//   - `@inhuman.tools/chunked-websocket/client` — `ChunkedWebSocket`, a
//     drop-in browser WebSocket polyfill.
//   - `@inhuman.tools/chunked-websocket/server` — `ChunkedDOTransport`, an
//     adapter for Cloudflare Durable Object hibernation API.
//
// The primitives below are exposed for tests and for protocols that
// can't use either adapter directly.
export {
  CHUNK_MAX_SIZE,
  RESET_SENTINEL,
  sendChunked,
  handleChunked,
  parseBatchMarker,
  type BatchKind,
  type ChunkedReceiveHandler,
  type SendCapableSocket,
  type ChunkedMessageData,
  type ChunkedMessageEvent,
} from "./protocol.js";

// Typed events surface for ChunkedWebSocket
export type { ChunkedWebSocketEventMap, ChunkedWebSocketProtocols } from "./ChunkedWebSocket.js";
