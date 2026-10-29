/**
 * Authenticated private data link. Public rooms stay on YjsServer; this
 * path is the runtime replica/barrier/RPC peer. No domain hosts.
 */
import { timingSafeEqual } from "node:crypto";

import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  admitPrivateEnvelope,
  advanceSequenceState,
  decodeBarrierRequest,
  decodePrivateControl,
  decodePrivateEnvelope,
  documentKeysEqual,
  encodeBarrierReply,
  encodeDocUpdate,
  encodeOccupancySnapshot,
  encodePrivateControl,
  encodePrivateEnvelope,
  MESSAGE_SYNC,
  type DocumentKey,
  type FrameClass,
  type PrivateControl,
  type PrivateEnvelope,
  type PrivateHelloAck,
  type SequenceState,
} from "@/protocol/document";
import {
  encodeJsonRpcError,
  encodeJsonRpcResult,
  jsonRpcRequest,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
} from "@/protocol/rpc";
import type { SupervisionIdentity } from "@/protocol/schemas";

import type { DocumentRef } from "./registry/index.js";
import type { PlaneSocket } from "./relay.js";
import { EXECUTION_UNAVAILABLE_CODE, EXECUTION_UNAVAILABLE_MESSAGE, type RpcHandler, YjsServer } from "./rooms.js";

export type PrivatePeerHubOptions = {
  readonly capability: string;
  readonly identity: SupervisionIdentity;
  readonly rpc?: RpcHandler;
};

function keyId(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

function credentialsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function authorizeHello(
  expected: { capability: string; identity: SupervisionIdentity },
  capability: string,
  identity: SupervisionIdentity,
): "ok" | "unauthorized" | "stale" {
  if (!credentialsEqual(capability, expected.capability)) return "unauthorized";
  if (identity.process.kind !== "runtime") return "unauthorized";
  if (identity.hypervisor.id !== expected.identity.hypervisor.id) {
    return "unauthorized";
  }
  if (identity.serverEpoch !== expected.identity.serverEpoch) {
    return identity.serverEpoch < expected.identity.serverEpoch ? "stale" : "unauthorized";
  }
  if (identity.runtimeGeneration < expected.identity.runtimeGeneration) {
    return "stale";
  }
  return "ok";
}

function readPeerUpdate(frame: Uint8Array): Uint8Array | null {
  try {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
    const syncType = decoding.readVarUint(decoder);
    if (syncType !== syncProtocol.messageYjsSyncStep2 && syncType !== syncProtocol.messageYjsUpdate) {
      return null;
    }
    return decoding.readVarUint8Array(decoder);
  } catch {
    return null;
  }
}

function sendHelloAck(socket: PlaneSocket, ack: PrivateHelloAck): void {
  socket.send(
    encodePrivateEnvelope({
      connectionEpoch: 0,
      sequence: 1,
      class: "control",
      payload: encodePrivateControl({ op: "hello-ack", ack }),
    }),
  );
}

export class PrivatePeerHub {
  readonly #server: YjsServer;
  readonly #capability: string;
  #identity: SupervisionIdentity;
  readonly #rpc: RpcHandler | undefined;
  readonly #held = new Map<string, { readonly key: DocumentKey; readonly stop: () => void }>();
  readonly #stopOccupancy: () => void;
  #socket: PlaneSocket | undefined;
  #peer: SupervisionIdentity | undefined;
  #authed = false;
  #connectionEpoch = 0;
  #outNext = 1;
  #inboundSeq: SequenceState = { epoch: 0, sequence: 0 };
  #inbound: Promise<void> = Promise.resolve();
  readonly #ignore = new WeakSet<PlaneSocket>();

  constructor(server: YjsServer, options: PrivatePeerHubOptions) {
    if (options.capability.length === 0) {
      throw new Error("capability is required");
    }
    this.#server = server;
    this.#capability = options.capability;
    this.#identity = {
      ...options.identity,
      serverEpoch: server.documents.serverEpoch,
    };
    this.#rpc = options.rpc;
    this.#stopOccupancy = server.watchOccupancy((snapshot) => {
      if (!this.#authed) return;
      this.#send("occupancy", encodeOccupancySnapshot(snapshot));
    });
  }

  get connectionEpoch(): number {
    return this.#connectionEpoch;
  }

  accept(socket: PlaneSocket): void {
    socket.onBinary((frame) => {
      if (this.#ignore.has(socket)) return;
      this.#enqueue(() => this.#onFrame(socket, frame));
    });
    socket.onClose(() => {
      if (this.#socket === socket) this.#detach(socket);
    });
  }

  [Symbol.dispose](): void {
    this.#stopOccupancy();
    this.#dropHeld();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#authed = false;
    socket?.close(1001, "hub closed");
  }

  #enqueue(run: () => Promise<void>): void {
    this.#inbound = this.#inbound.then(run, run);
  }

  async #onFrame(socket: PlaneSocket, frame: Uint8Array): Promise<void> {
    const envelope = decodePrivateEnvelope(frame);
    if (envelope == null) return;
    const control = envelope.class === "control" ? decodePrivateControl(envelope.payload) : null;
    if (control?.op === "hello") {
      if (socket === this.#socket && this.#authed) return;
      this.#hello(socket, control.hello);
      return;
    }
    if (socket !== this.#socket || !this.#authed) return;
    const admission = admitPrivateEnvelope(this.#inboundSeq, envelope);
    if (admission.action === "drop") return;
    if (admission.action === "reject") {
      this.#reject(admission.reason);
      return;
    }
    advanceSequenceState(this.#inboundSeq, envelope);
    switch (envelope.class) {
      case "sync":
        this.#sync(socket, envelope);
        return;
      case "barrier":
        await this.#barrier(socket, this.#connectionEpoch, envelope);
        return;
      case "rpc":
        await this.#rpcCall(socket, this.#connectionEpoch, envelope);
        return;
      case "control":
        if (control != null) await this.#control(socket, control);
        return;
      case "occupancy":
        return;
    }
  }

  #hello(socket: PlaneSocket, hello: { capability: string; identity: SupervisionIdentity }): void {
    const reason = authorizeHello(
      { capability: this.#capability, identity: this.#identity },
      hello.capability,
      hello.identity,
    );
    if (reason !== "ok") {
      sendHelloAck(socket, { ok: false, reason });
      socket.close(1008, reason);
      return;
    }
    if (
      this.#peer != null &&
      this.#socket != null &&
      this.#socket !== socket &&
      this.#peer.process.id !== hello.identity.process.id
    ) {
      sendHelloAck(socket, { ok: false, reason: "busy" });
      socket.close(1008, "busy");
      return;
    }
    this.#replace(socket, hello.identity);
    this.#send(
      "control",
      encodePrivateControl({
        op: "hello-ack",
        ack: {
          ok: true,
          serverEpoch: this.#identity.serverEpoch,
          runtimeGeneration: this.#identity.runtimeGeneration,
          connectionEpoch: this.#connectionEpoch,
        },
      }),
    );
    this.#send("occupancy", encodeOccupancySnapshot(this.#server.occupancy()));
  }

  async #control(socket: PlaneSocket, control: PrivateControl): Promise<void> {
    if (socket !== this.#socket) return;
    switch (control.op) {
      case "open-existing":
        await this.#openExisting(socket, control.requestId, control.key);
        return;
      case "create":
        await this.#create(socket, control.requestId, control.key, control.initial);
        return;
      case "release":
        this.#release(control.requestId, control.key);
        return;
      default:
        return;
    }
  }

  async #openExisting(socket: PlaneSocket, requestId: number, key: DocumentKey): Promise<void> {
    const opened = await this.#server.openExisting(key);
    if (socket !== this.#socket) return;
    if (!opened.ok) {
      this.#send(
        "control",
        encodePrivateControl({
          op: "open-failed",
          requestId,
          reason: opened.reason,
        }),
        key,
      );
      return;
    }
    this.#snapshot(socket, requestId, "opened", opened.room.ref);
  }

  async #create(socket: PlaneSocket, requestId: number, key: DocumentKey, initial: Uint8Array): Promise<void> {
    const created = await this.#server.create(key, initial.byteLength === 0 ? undefined : initial);
    if (socket !== this.#socket) return;
    if (!created.ok) {
      this.#send(
        "control",
        encodePrivateControl({
          op: "create-failed",
          requestId,
          reason: created.reason,
        }),
        key,
      );
      return;
    }
    this.#snapshot(socket, requestId, "created", created.ref);
  }

  #release(requestId: number, key: DocumentKey): void {
    this.#dropOne(key);
    this.#send("control", encodePrivateControl({ op: "released", requestId }), key);
  }

  #sync(socket: PlaneSocket, envelope: PrivateEnvelope): void {
    if (envelope.document == null) return;
    const update = readPeerUpdate(envelope.payload);
    if (update == null) return;
    const applied = this.#server.documents.applyUpdate(envelope.document, update, socket);
    if (!applied.ok) {
      this.#detach(socket);
      socket.close(1008, applied.reason);
    }
  }

  async #barrier(socket: PlaneSocket, epoch: number, envelope: PrivateEnvelope): Promise<void> {
    const request = decodeBarrierRequest(envelope.payload);
    if (request == null || envelope.document == null) return;
    if (!documentKeysEqual(envelope.document, request.checkpoint.key)) {
      this.#send(
        "barrier",
        encodeBarrierReply({
          requestId: request.requestId,
          result: { ok: false, reason: "disconnected" },
        }),
        envelope.document,
      );
      return;
    }
    const result = await this.#server.documents.flush(request.checkpoint.key, request.checkpoint, {
      runtimeGeneration: this.#peer?.runtimeGeneration ?? 0,
      connectionEpoch: epoch,
    });
    if (socket !== this.#socket || epoch !== this.#connectionEpoch) return;
    this.#send("barrier", encodeBarrierReply({ requestId: request.requestId, result }), request.checkpoint.key);
  }

  async #rpcCall(socket: PlaneSocket, epoch: number, envelope: PrivateEnvelope): Promise<void> {
    if (envelope.document == null) return;
    const text = new TextDecoder().decode(envelope.payload);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      this.#rpcReply(socket, epoch, envelope.document, encodeJsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"));
      return;
    }
    const parsed = jsonRpcRequest.safeParse(raw);
    if (!parsed.success) {
      this.#rpcReply(
        socket,
        epoch,
        envelope.document,
        encodeJsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
      );
      return;
    }
    const { method, params, id } = parsed.data;
    if (this.#rpc == null) {
      if (id === undefined) return;
      this.#rpcReply(
        socket,
        epoch,
        envelope.document,
        encodeJsonRpcError(id, EXECUTION_UNAVAILABLE_CODE, EXECUTION_UNAVAILABLE_MESSAGE),
      );
      return;
    }
    try {
      const result = await this.#rpc(method, params, envelope.document);
      if (id === undefined) return;
      this.#rpcReply(socket, epoch, envelope.document, encodeJsonRpcResult(id, result));
    } catch (error) {
      if (id === undefined) return;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? Number((error as { code: unknown }).code)
          : JSON_RPC_INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : "Internal error";
      this.#rpcReply(
        socket,
        epoch,
        envelope.document,
        encodeJsonRpcError(id, Number.isInteger(code) ? code : JSON_RPC_INTERNAL_ERROR, message),
      );
    }
  }

  #rpcReply(socket: PlaneSocket, epoch: number, key: DocumentKey, text: string): void {
    if (socket !== this.#socket || epoch !== this.#connectionEpoch) return;
    this.#send("rpc", new TextEncoder().encode(text), key);
  }

  #snapshot(socket: PlaneSocket, requestId: number, op: "opened" | "created", ref: DocumentRef): void {
    if (!this.#hold(ref.key, ref.doc, socket)) {
      if (op === "created") {
        this.#send(
          "control",
          encodePrivateControl({
            op: "create-failed",
            requestId,
            reason: "overload",
          }),
          ref.key,
        );
      } else {
        this.#send(
          "control",
          encodePrivateControl({
            op: "open-failed",
            requestId,
            reason: "not-found",
          }),
          ref.key,
        );
      }
      return;
    }
    this.#send(
      "control",
      encodePrivateControl({
        op,
        requestId,
        revision: ref.revision,
        guid: ref.doc.guid,
        image: Y.encodeStateAsUpdate(ref.doc),
      }),
      ref.key,
    );
  }

  #hold(key: DocumentKey, doc: Y.Doc, origin: PlaneSocket): boolean {
    const id = keyId(key);
    if (this.#held.has(id)) return true;
    if (!this.#server.acquire(key)) return false;
    const onUpdate = (update: Uint8Array, updateOrigin: unknown): void => {
      if (updateOrigin === origin) return;
      if (this.#socket !== origin) return;
      this.#send("sync", encodeDocUpdate(update), key);
    };
    doc.on("update", onUpdate);
    this.#held.set(id, {
      key,
      stop: () => {
        doc.off("update", onUpdate);
      },
    });
    return true;
  }

  #dropOne(key: DocumentKey): void {
    const id = keyId(key);
    const held = this.#held.get(id);
    if (held == null) return;
    held.stop();
    this.#held.delete(id);
    this.#server.park(key);
  }

  #dropHeld(): void {
    for (const held of this.#held.values()) {
      held.stop();
      this.#server.park(held.key);
    }
    this.#held.clear();
  }

  #replace(socket: PlaneSocket, peer: SupervisionIdentity): void {
    const previous = this.#socket;
    this.#dropHeld();
    this.#socket = socket;
    this.#peer = peer;
    this.#identity = {
      ...this.#identity,
      runtimeGeneration: peer.runtimeGeneration,
    };
    this.#authed = true;
    this.#connectionEpoch += 1;
    this.#outNext = 1;
    this.#inboundSeq = { epoch: this.#connectionEpoch, sequence: 0 };
    if (previous != null && previous !== socket) {
      previous.close(1001, "replaced");
    }
  }

  #detach(socket: PlaneSocket): void {
    this.#ignore.add(socket);
    if (this.#socket !== socket) return;
    this.#dropHeld();
    this.#socket = undefined;
    this.#authed = false;
    this.#peer = undefined;
  }

  #reject(reason: "gap" | "reset" | "stale-epoch"): void {
    const socket = this.#socket;
    this.#send("control", encodePrivateControl({ op: "reject", reason }));
    if (socket == null) return;
    this.#detach(socket);
    socket.close(1002, reason);
  }

  #send(frameClass: FrameClass, payload: Uint8Array, document?: DocumentKey): void {
    const socket = this.#socket;
    if (socket == null) return;
    const envelope: PrivateEnvelope =
      document == null
        ? {
            connectionEpoch: this.#connectionEpoch,
            sequence: this.#outNext,
            class: frameClass,
            payload,
          }
        : {
            connectionEpoch: this.#connectionEpoch,
            sequence: this.#outNext,
            class: frameClass,
            document,
            payload,
          };
    this.#outNext += 1;
    socket.send(encodePrivateEnvelope(envelope));
  }
}
