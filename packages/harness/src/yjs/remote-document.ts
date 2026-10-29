/**
 * Runtime-side document adapter over the private peer link. Local Y.Doc
 * replicas stay consistent with the server; this adapter does not host
 * session or kernel interpreters.
 */
import * as Y from "yjs";

import {
  admitPrivateEnvelope,
  advanceSequenceState,
  applyPeerSyncFrame,
  checkpointOf,
  decodeBarrierReply,
  decodeOccupancySnapshot,
  decodePrivateControl,
  decodePrivateEnvelope,
  encodeBarrierRequest,
  encodeDocUpdate,
  encodePrivateControl,
  encodePrivateEnvelope,
  type DocumentCheckpoint,
  type DocumentKey,
  type FlushResult,
  type FrameClass,
  type OccupancySnapshot,
  type PrivateControl,
  type PrivateEnvelope,
  type SequenceState,
} from "@/protocol/document";
import { encodeJsonRpcRequest, jsonRpcResponse, RpcClientError } from "@/protocol/rpc";
import type { SupervisionIdentity } from "@/protocol/schemas";

import type { CreateResult, OpenResult } from "./document-service.js";
import type { DocumentRef } from "./registry/index.js";
import type { PlaneSocket } from "./relay.js";

const REMOTE_ORIGIN = "remote-document";

export type RemoteConnectOptions = {
  readonly capability: string;
  readonly identity: SupervisionIdentity;
};

export type RemoteConnectResult =
  | { readonly ok: true; readonly adapter: RemoteDocumentAdapter }
  | {
      readonly ok: false;
      readonly reason: "unauthorized" | "busy" | "stale" | "disconnected";
    };

type PendingOpen = {
  readonly kind: "open";
  readonly key: DocumentKey;
  readonly resolve: (result: OpenResult) => void;
};
type PendingCreate = {
  readonly kind: "create";
  readonly key: DocumentKey;
  readonly resolve: (result: CreateResult) => void;
};
type PendingFlush = {
  readonly kind: "flush";
  readonly resolve: (result: FlushResult) => void;
};
type PendingRelease = {
  readonly kind: "release";
  readonly resolve: () => void;
};
type PendingRpc = {
  readonly kind: "rpc";
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};
type ControlPending = PendingOpen | PendingCreate | PendingFlush | PendingRelease;

type LocalReplica = {
  readonly key: DocumentKey;
  readonly doc: Y.Doc;
  revision: number;
  readonly onUpdate: (update: Uint8Array, origin: unknown) => void;
};

function keyId(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

function toRef(replica: LocalReplica): DocumentRef {
  return { key: replica.key, doc: replica.doc, revision: replica.revision };
}

export class RemoteDocumentAdapter {
  readonly #socket: PlaneSocket;
  readonly #capability: string;
  readonly #helloIdentity: SupervisionIdentity;
  readonly #replicas = new Map<string, LocalReplica>();
  readonly #pending = new Map<number, ControlPending>();
  readonly #rpc = new Map<number, PendingRpc>();
  #inboundSeq: SequenceState = { epoch: 0, sequence: 0 };
  #outNext = 1;
  #outEpoch = 0;
  #serverEpoch = 0;
  #connectionEpoch = 0;
  #authed = false;
  #closed = false;
  #occupancy: OccupancySnapshot | undefined;
  #inbound: Promise<void> = Promise.resolve();
  #nextId = 1;
  #nextRpc = 1;
  readonly ready: Promise<RemoteConnectResult>;
  #settleReady: ((result: RemoteConnectResult) => void) | undefined;

  constructor(socket: PlaneSocket, options: RemoteConnectOptions) {
    this.#socket = socket;
    this.#capability = options.capability;
    this.#helloIdentity = options.identity;
    this.ready = new Promise((resolve) => {
      this.#settleReady = resolve;
    });
    socket.onBinary((frame) => {
      this.#enqueue(() => this.#onFrame(frame));
    });
    socket.onClose(() => {
      this.#enqueue(async () => {
        this.#onClose();
      });
    });
    this.#send(
      "control",
      encodePrivateControl({
        op: "hello",
        hello: {
          capability: this.#capability,
          identity: this.#helloIdentity,
        },
      }),
    );
  }

  get connectionEpoch(): number {
    return this.#connectionEpoch;
  }

  get serverEpoch(): number {
    return this.#serverEpoch;
  }

  occupancy(): OccupancySnapshot | undefined {
    return this.#occupancy;
  }

  getLoaded(key: DocumentKey): DocumentRef | undefined {
    const replica = this.#replicas.get(keyId(key));
    return replica == null ? undefined : toRef(replica);
  }

  loaded(): readonly DocumentRef[] {
    return [...this.#replicas.values()].map(toRef);
  }

  checkpoint(key: DocumentKey): DocumentCheckpoint | undefined {
    const replica = this.#replicas.get(keyId(key));
    if (replica == null) return undefined;
    return checkpointOf(replica.doc, replica.key, this.#serverEpoch, replica.revision + 1);
  }

  async openExisting(key: DocumentKey): Promise<OpenResult> {
    if (this.#closed) return { ok: false, reason: "not-found" };
    const loaded = this.getLoaded(key);
    if (loaded != null) return { ok: true, ref: loaded };
    const requestId = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve) => {
      this.#pending.set(requestId, { kind: "open", key, resolve });
      this.#send("control", encodePrivateControl({ op: "open-existing", requestId, key }), key);
    });
  }

  async create(key: DocumentKey, initial?: Uint8Array): Promise<CreateResult> {
    if (this.#closed) return { ok: false, reason: "storage-failed" };
    const loaded = this.getLoaded(key);
    if (loaded != null) return { ok: true, ref: loaded };
    const requestId = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve) => {
      this.#pending.set(requestId, { kind: "create", key, resolve });
      this.#send(
        "control",
        encodePrivateControl({
          op: "create",
          requestId,
          key,
          initial: initial ?? new Uint8Array(),
        }),
        key,
      );
    });
  }

  async flush(key: DocumentKey, checkpoint?: DocumentCheckpoint): Promise<FlushResult> {
    if (this.#closed) return { ok: false, reason: "disconnected" };
    const captured = checkpoint ?? this.checkpoint(key);
    if (captured == null) return { ok: false, reason: "disconnected" };
    const requestId = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve) => {
      this.#pending.set(requestId, { kind: "flush", resolve });
      this.#send("barrier", encodeBarrierRequest({ requestId, checkpoint: captured }), key);
    });
  }

  async release(key: DocumentKey): Promise<void> {
    this.#dropReplica(key);
    if (this.#closed) return;
    const requestId = this.#nextId;
    this.#nextId += 1;
    await new Promise<void>((resolve) => {
      this.#pending.set(requestId, { kind: "release", resolve });
      this.#send("control", encodePrivateControl({ op: "release", requestId, key }), key);
    });
  }

  async call(key: DocumentKey, method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("disconnected");
    const id = this.#nextRpc;
    this.#nextRpc += 1;
    return new Promise((resolve, reject) => {
      this.#rpc.set(id, { kind: "rpc", resolve, reject });
      this.#send("rpc", new TextEncoder().encode(encodeJsonRpcRequest(id, method, params)), key);
    });
  }

  [Symbol.dispose](): void {
    if (this.#closed) return;
    this.#socket.close(1001, "adapter closed");
    this.#onClose();
  }

  #enqueue(run: () => Promise<void>): void {
    this.#inbound = this.#inbound.then(run, run);
  }

  async #onFrame(frame: Uint8Array): Promise<void> {
    const envelope = decodePrivateEnvelope(frame);
    if (envelope == null) return;
    if (!this.#authed) {
      this.#helloAck(envelope);
      return;
    }
    const admission = admitPrivateEnvelope(this.#inboundSeq, envelope);
    if (admission.action === "drop") return;
    if (admission.action === "reject") {
      this.#socket.close(1002, admission.reason);
      return;
    }
    advanceSequenceState(this.#inboundSeq, envelope);
    switch (envelope.class) {
      case "sync":
        this.#sync(envelope);
        return;
      case "barrier":
        this.#barrier(envelope);
        return;
      case "rpc":
        this.#rpcReply(envelope);
        return;
      case "occupancy":
        this.#occupancyFrame(envelope);
        return;
      case "control": {
        const control = decodePrivateControl(envelope.payload);
        if (control != null) this.#control(control, envelope.document);
        return;
      }
    }
  }

  #helloAck(envelope: PrivateEnvelope): void {
    if (envelope.class !== "control") return;
    const control = decodePrivateControl(envelope.payload);
    if (control?.op !== "hello-ack") return;
    if (!control.ack.ok) {
      this.#finish({ ok: false, reason: control.ack.reason });
      return;
    }
    this.#authed = true;
    this.#serverEpoch = control.ack.serverEpoch;
    this.#connectionEpoch = control.ack.connectionEpoch;
    this.#outEpoch = control.ack.connectionEpoch;
    this.#outNext = 1;
    this.#inboundSeq = { epoch: 0, sequence: 0 };
    const admission = admitPrivateEnvelope(this.#inboundSeq, envelope);
    if (admission.action === "apply" || admission.action === "reset") {
      advanceSequenceState(this.#inboundSeq, envelope);
    }
    this.#finish({ ok: true, adapter: this });
  }

  #control(control: PrivateControl, document: DocumentKey | undefined): void {
    switch (control.op) {
      case "opened":
        this.#opened(control, document);
        return;
      case "created":
        this.#created(control, document);
        return;
      case "open-failed":
        this.#openFailed(control);
        return;
      case "create-failed":
        this.#createFailed(control);
        return;
      case "released":
        this.#released(control.requestId);
        return;
      case "reject":
        this.#socket.close(1002, control.reason);
        return;
      default:
        return;
    }
  }

  #opened(control: Extract<PrivateControl, { op: "opened" }>, document: DocumentKey | undefined): void {
    const pending = this.#pending.get(control.requestId);
    if (pending?.kind !== "open") return;
    this.#pending.delete(control.requestId);
    const key = document ?? pending.key;
    pending.resolve({ ok: true, ref: this.#install(key, control) });
  }

  #created(control: Extract<PrivateControl, { op: "created" }>, document: DocumentKey | undefined): void {
    const pending = this.#pending.get(control.requestId);
    if (pending?.kind !== "create") return;
    this.#pending.delete(control.requestId);
    const key = document ?? pending.key;
    pending.resolve({ ok: true, ref: this.#install(key, control) });
  }

  #openFailed(control: Extract<PrivateControl, { op: "open-failed" }>): void {
    const pending = this.#pending.get(control.requestId);
    if (pending?.kind !== "open") return;
    this.#pending.delete(control.requestId);
    pending.resolve({ ok: false, reason: control.reason });
  }

  #createFailed(control: Extract<PrivateControl, { op: "create-failed" }>): void {
    const pending = this.#pending.get(control.requestId);
    if (pending?.kind !== "create") return;
    this.#pending.delete(control.requestId);
    pending.resolve({ ok: false, reason: control.reason });
  }

  #released(requestId: number): void {
    const pending = this.#pending.get(requestId);
    if (pending?.kind !== "release") return;
    this.#pending.delete(requestId);
    pending.resolve();
  }

  #sync(envelope: PrivateEnvelope): void {
    if (envelope.document == null) return;
    const replica = this.#replicas.get(keyId(envelope.document));
    if (replica == null) return;
    applyPeerSyncFrame(envelope.payload, replica.doc, REMOTE_ORIGIN);
  }

  #barrier(envelope: PrivateEnvelope): void {
    const reply = decodeBarrierReply(envelope.payload);
    if (reply == null) return;
    const pending = this.#pending.get(reply.requestId);
    if (pending?.kind !== "flush") return;
    this.#pending.delete(reply.requestId);
    if (reply.result.ok && envelope.document != null) {
      const replica = this.#replicas.get(keyId(envelope.document));
      if (replica != null) replica.revision = reply.result.receipt.revision;
    }
    pending.resolve(reply.result);
  }

  #rpcReply(envelope: PrivateEnvelope): void {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(envelope.payload)) as unknown;
    } catch {
      return;
    }
    const parsed = jsonRpcResponse.safeParse(raw);
    if (!parsed.success || parsed.data.id == null) return;
    const id = parsed.data.id;
    if (typeof id !== "number") return;
    const pending = this.#rpc.get(id);
    if (pending == null) return;
    this.#rpc.delete(id);
    if ("error" in parsed.data) {
      pending.reject(new RpcClientError(parsed.data.error.code, parsed.data.error.message));
      return;
    }
    pending.resolve(parsed.data.result);
  }

  #occupancyFrame(envelope: PrivateEnvelope): void {
    const snapshot = decodeOccupancySnapshot(envelope.payload);
    if (snapshot == null) return;
    this.#occupancy = snapshot;
  }

  #install(key: DocumentKey, snapshot: { revision: number; guid: string; image: Uint8Array }): DocumentRef {
    const existing = this.#replicas.get(keyId(key));
    if (existing != null) {
      Y.applyUpdate(existing.doc, snapshot.image, REMOTE_ORIGIN);
      existing.revision = snapshot.revision;
      return toRef(existing);
    }
    const doc = new Y.Doc({ guid: snapshot.guid });
    if (snapshot.image.byteLength > 0) {
      Y.applyUpdate(doc, snapshot.image, REMOTE_ORIGIN);
    }
    const replica: LocalReplica = {
      key,
      doc,
      revision: snapshot.revision,
      onUpdate: (update, origin) => {
        if (origin === REMOTE_ORIGIN) return;
        this.#send("sync", encodeDocUpdate(update), key);
      },
    };
    doc.on("update", replica.onUpdate);
    this.#replicas.set(keyId(key), replica);
    return toRef(replica);
  }

  #dropReplica(key: DocumentKey): void {
    const replica = this.#replicas.get(keyId(key));
    if (replica == null) return;
    replica.doc.off("update", replica.onUpdate);
    this.#replicas.delete(keyId(key));
    replica.doc.destroy();
  }

  #send(frameClass: FrameClass, payload: Uint8Array, document?: DocumentKey): void {
    if (this.#closed) return;
    const envelope: PrivateEnvelope =
      document == null
        ? {
            connectionEpoch: this.#outEpoch,
            sequence: this.#outNext,
            class: frameClass,
            payload,
          }
        : {
            connectionEpoch: this.#outEpoch,
            sequence: this.#outNext,
            class: frameClass,
            document,
            payload,
          };
    this.#outNext += 1;
    this.#socket.send(encodePrivateEnvelope(envelope));
  }

  #finish(result: RemoteConnectResult): void {
    const settle = this.#settleReady;
    this.#settleReady = undefined;
    settle?.(result);
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#authed) this.#finish({ ok: false, reason: "disconnected" });
    for (const pending of this.#pending.values()) {
      switch (pending.kind) {
        case "flush": {
          pending.resolve({ ok: false, reason: "disconnected" });

          break;
        }
        case "open": {
          pending.resolve({ ok: false, reason: "not-found" });

          break;
        }
        case "create": {
          pending.resolve({ ok: false, reason: "storage-failed" });

          break;
        }
        default: {
          pending.resolve();
        }
      }
    }
    this.#pending.clear();
    for (const rpc of this.#rpc.values()) {
      rpc.reject(new Error("disconnected"));
    }
    this.#rpc.clear();
    for (const replica of this.#replicas.values()) {
      replica.doc.off("update", replica.onUpdate);
      replica.doc.destroy();
    }
    this.#replicas.clear();
  }
}

export function connectRemoteDocument(
  socket: PlaneSocket,
  options: RemoteConnectOptions,
): Promise<RemoteConnectResult> {
  return new RemoteDocumentAdapter(socket, options).ready;
}
