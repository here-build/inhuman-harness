/**
 * Public rooms over DocumentService. Occupancy is a fact; park() drops an
 * execution hold without closing the room or destroying another consumer's replica.
 */
import { DisposableClass, disposableGuard } from "@inhuman.tools/harness-commons";
import type * as Y from "yjs";

import type { DocumentKey, OccupancySeat, OccupancySnapshot } from "@/protocol/document";
import {
  encodeJsonRpcError,
  encodeJsonRpcResult,
  jsonRpcRequest,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
} from "@/protocol/rpc";

import { DocumentService, type CreateResult, type DocumentServiceOptions } from "./document-service.js";
import type { DocumentRef } from "./registry/index.js";
import { AwarenessRoom, attachLens, type PlaneSocket } from "./relay.js";

export const EXECUTION_UNAVAILABLE_CODE = -32_004;
export const EXECUTION_UNAVAILABLE_MESSAGE = "execution-unavailable";

export type RpcHandler = (method: string, params: unknown, key: DocumentKey) => Promise<unknown>;

export type OpenRoomResult =
  | { readonly ok: true; readonly room: DocumentRoom }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "overload" | "corrupt";
    };

function keyId(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

class OccupancyLedger {
  #sequence = 0;
  #nextClientId = 1;
  readonly #seats = new Map<PlaneSocket, OccupancySeat>();
  readonly #listeners = new Set<(snapshot: OccupancySnapshot) => void>();

  constructor(readonly serverEpoch: number) {}

  snapshot(): OccupancySnapshot {
    return {
      serverEpoch: this.serverEpoch,
      sequence: this.#sequence,
      seats: [...this.#seats.values()],
    };
  }

  watch(listener: (snapshot: OccupancySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  join(socket: PlaneSocket, sessionId: string): OccupancySnapshot {
    const seat: OccupancySeat = {
      sessionId,
      clientId: this.#nextClientId,
    };
    this.#nextClientId += 1;
    this.#seats.set(socket, seat);
    return this.#emit();
  }

  leave(socket: PlaneSocket): OccupancySnapshot | undefined {
    if (!this.#seats.delete(socket)) return undefined;
    return this.#emit();
  }

  #emit(): OccupancySnapshot {
    this.#sequence += 1;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }
}

export class DocumentRoom extends DisposableClass {
  readonly awareness = new AwarenessRoom();
  readonly #sockets = new Set<PlaneSocket>();
  #executionHolds = 0;
  #closeCode = 1001;
  #closeReason = "room closed";

  constructor(readonly ref: DocumentRef) {
    super();
  }

  get key(): DocumentKey {
    return this.ref.key;
  }

  get doc(): Y.Doc {
    return this.ref.doc;
  }

  get closed(): boolean {
    return this.disposed;
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  get executionHolds(): number {
    return this.#executionHolds;
  }

  /** Extra replica consumer (runtime). park() releases this, not the room. */
  @disposableGuard
  acquire(): void {
    this.#executionHolds += 1;
  }

  /**
   * Drop one execution hold. Does not close the room or disconnect sockets,
   * and does not destroy a replica another consumer still holds.
   */
  park(): void {
    if (this.#executionHolds > 0) this.#executionHolds -= 1;
  }

  @disposableGuard
  hold(socket: PlaneSocket): void {
    this.#sockets.add(socket);
    socket.onClose(() => {
      this.#sockets.delete(socket);
    });
  }

  close(code = 1001, reason = "room closed"): void {
    if (this.disposed) return;
    this.#closeCode = code;
    this.#closeReason = reason;
    this[Symbol.dispose]();
  }

  protected dispose(): void {
    this.#executionHolds = 0;
    this.#sockets.clear();
    this.awareness.close(this.#closeCode, this.#closeReason);
  }
}

export class YjsServer {
  readonly documents: DocumentService;
  readonly #rooms = new Map<string, DocumentRoom>();
  readonly #occupancy: OccupancyLedger;
  readonly #ops = new Map<string, Promise<void>>();

  constructor(options: DocumentServiceOptions) {
    this.documents = new DocumentService(options);
    this.#occupancy = new OccupancyLedger(this.documents.serverEpoch);
  }

  occupancy(): OccupancySnapshot {
    return this.#occupancy.snapshot();
  }

  watchOccupancy(listener: (snapshot: OccupancySnapshot) => void): () => void {
    return this.#occupancy.watch(listener);
  }

  getLoaded(key: DocumentKey): DocumentRef | undefined {
    return this.documents.getLoaded(key);
  }

  /**
   * Load an on-disk image into a public room. Never creates a missing
   * identity and never constructs an interpreter.
   */
  async openExisting(key: DocumentKey): Promise<OpenRoomResult> {
    return this.#locked(key, () => this.#openExistingNow(key));
  }

  /** Explicit storage create. HTTP GET/open-existing never calls this. */
  async create(key: DocumentKey, initial?: Uint8Array): Promise<CreateResult> {
    return this.#locked(key, async () => {
      const existing = this.#rooms.get(keyId(key));
      if (existing != null && !existing.closed) {
        return { ok: true as const, ref: existing.ref };
      }
      const created = await this.documents.create(key, initial);
      if (!created.ok) return created;
      this.#adopt(created.ref);
      return created;
    });
  }

  /**
   * Sync attach onto an already-opened room. Closes the socket instead of
   * leaving a connected client with no replica. Optional `rpc` forwards
   * envelopes; missing execution is `-32004`, not local dispatch.
   */
  attach(key: DocumentKey, socket: PlaneSocket, rpc?: RpcHandler): boolean {
    const room = this.#rooms.get(keyId(key));
    if (room == null || room.closed) {
      socket.close(1001, "room closed");
      return false;
    }
    room.hold(socket);
    socket.onClose(() => {
      this.#occupancy.leave(socket);
    });
    if (key.kind === "sessions") this.#occupancy.join(socket, key.id);
    attachLens(room.doc, socket, room.awareness);
    socket.onText((text) => {
      void relayJsonRpc(socket, text, rpc, key);
    });
    return true;
  }

  /**
   * Extra replica consumer (private peer / runtime). park() releases this,
   * not the room.
   */
  acquire(key: DocumentKey): boolean {
    const room = this.#rooms.get(keyId(key));
    if (room == null || room.closed) return false;
    room.acquire();
    return true;
  }

  /**
   * Release execution for this room. Connected sockets and other replica
   * consumers keep the document.
   */
  park(key: DocumentKey): void {
    this.#rooms.get(keyId(key))?.park();
  }

  closeRoom(key: DocumentKey, code?: number, reason?: string): void {
    const id = keyId(key);
    const room = this.#rooms.get(id);
    if (room == null) return;
    this.#rooms.delete(id);
    room.close(code, reason);
    this.documents.release(key);
  }

  [Symbol.dispose](): void {
    const rooms = [...this.#rooms.values()];
    for (const room of rooms) this.closeRoom(room.key);
  }

  async #openExistingNow(key: DocumentKey): Promise<OpenRoomResult> {
    const existing = this.#rooms.get(keyId(key));
    if (existing != null && !existing.closed) {
      return { ok: true, room: existing };
    }
    const opened = await this.documents.openExisting(key);
    if (!opened.ok) return opened;
    return { ok: true, room: this.#adopt(opened.ref) };
  }

  #adopt(ref: DocumentRef): DocumentRoom {
    const id = keyId(ref.key);
    const existing = this.#rooms.get(id);
    if (existing != null && !existing.closed) return existing;
    const room = new DocumentRoom(ref);
    this.#rooms.set(id, room);
    return room;
  }

  async #locked<T>(key: DocumentKey, run: () => Promise<T>): Promise<T> {
    const id = keyId(key);
    const previous = this.#ops.get(id);
    const execute = previous == null ? run() : previous.then(run, run);
    const tracked = execute.then(
      () => undefined,
      () => undefined,
    );
    this.#ops.set(id, tracked);
    void tracked.then(() => {
      if (this.#ops.get(id) === tracked) this.#ops.delete(id);
      return undefined;
    });
    return execute;
  }
}

async function relayJsonRpc(
  socket: PlaneSocket,
  text: string,
  handler: RpcHandler | undefined,
  key: DocumentKey,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    socket.sendText(encodeJsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"));
    return;
  }

  const parsed = jsonRpcRequest.safeParse(raw);
  if (!parsed.success) {
    socket.sendText(encodeJsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"));
    return;
  }

  const { method, params, id } = parsed.data;
  if (handler == null) {
    if (id === undefined) return;
    socket.sendText(encodeJsonRpcError(id, EXECUTION_UNAVAILABLE_CODE, EXECUTION_UNAVAILABLE_MESSAGE));
    return;
  }

  try {
    const result = await handler(method, params, key);
    if (id === undefined) return;
    socket.sendText(encodeJsonRpcResult(id, result));
  } catch (error) {
    if (id === undefined) return;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? Number((error as { code: unknown }).code)
        : JSON_RPC_INTERNAL_ERROR;
    const message = error instanceof Error ? error.message : "Internal error";
    socket.sendText(encodeJsonRpcError(id, Number.isInteger(code) ? code : JSON_RPC_INTERNAL_ERROR, message));
  }
}
