import { handleChunked, sendChunked } from "@inhuman.tools/chunked-websocket";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "../sync/constants.js";
import {
  encodeDocUpdate,
  encodeSyncStep1,
  handleSyncFrame,
  peekFrame,
  SYNC_STEP1,
  SYNC_STEP2,
} from "../sync/protocol.js";

export type Frame = string | Uint8Array;

/** A socket the test drives: chunked framing in and out, application frames queued. */
export class Peer {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly handlers: ((f: Frame) => boolean)[] = [];

  constructor(readonly ws: WebSocket) {
    const receive = handleChunked((data) => this.push(typeof data === "string" ? data : new Uint8Array(data)));
    ws.addEventListener("message", (e) => receive({ data: e.data as string | ArrayBuffer }));
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
    ws.binaryType = "arraybuffer";
    ws.accept();
  }

  /** A handler that returns true consumes the frame. */
  handle(h: (f: Frame) => boolean): void {
    this.handlers.push(h);
  }

  private push(f: Frame): void {
    if (!this.handlers.some((h) => h(f))) this.frames.push(f);
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters) w();
  }

  send(data: Frame): void {
    if (this.ws.readyState !== 1) return;
    sendChunked(
      typeof data === "string"
        ? data
        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer),
      this.ws,
    );
  }

  /** Wait until a condition holds, checked on every frame/close. */
  async until<T>(check: () => T | undefined | false, label: string, ms = 5000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v !== undefined && v !== false) return v;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const done = () => {
          this.waiters.delete(done);
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(done, 50);
        this.waiters.add(done);
      });
    }
  }

  /** Take the first queued frame matching `pred`. */
  async take<T extends Frame>(pred: (f: Frame) => f is T, label: string): Promise<T>;
  async take(pred: (f: Frame) => boolean, label: string): Promise<Frame>;
  async take(pred: (f: Frame) => boolean, label: string): Promise<Frame> {
    return this.until(() => {
      const i = this.frames.findIndex(pred);
      return i === -1 ? undefined : this.frames.splice(i, 1)[0]!;
    }, label);
  }

  takeJson = async (pred: (j: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> => {
    const text = (await this.take((f) => {
      if (typeof f !== "string") return false;
      try {
        return pred(JSON.parse(f) as Record<string, unknown>);
      } catch {
        return false;
      }
    }, label)) as string;
    return JSON.parse(text) as Record<string, unknown>;
  };

  async closedWith(): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closed ?? undefined, "close");
  }

  close(code = 1000, reason = ""): void {
    this.ws.close(code, reason);
  }
}

/** A y-websocket-style replica: says step 1 on open, answers the peer's, relays its own edits. */
export class YPeer extends Peer {
  readonly doc = new Y.Doc();
  /** Sync step 2 arrived: the peer answered our step 1. */
  synced = false;
  awareness: Uint8Array[] = [];
  queries = 0;
  /** Sync step 1 frames received from the peer. */
  step1s = 0;

  constructor(ws: WebSocket) {
    super(ws);
    this.handle((f) => {
      if (typeof f === "string") return false;
      const head = peekFrame(f);
      if (head.type === MESSAGE_SYNC) {
        if (head.sync === SYNC_STEP2) this.synced = true;
        if (head.sync === SYNC_STEP1) this.step1s++;
        const reply = handleSyncFrame(f, this.doc, "remote");
        if (reply !== null) this.send(reply);
        return true;
      }
      if (head.type === MESSAGE_AWARENESS) {
        this.awareness.push(f);
        return true;
      }
      if (head.type === 3) {
        this.queries++;
        return true;
      }
      return false;
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") this.send(encodeDocUpdate(update));
    });
    this.send(encodeSyncStep1(this.doc));
  }
}

/** y-protocols awareness frame (type byte included) for one client. */
export function awarenessFrame(id: number, clock: number, state: unknown): Uint8Array {
  const payload = encoding.createEncoder();
  encoding.writeVarUint(payload, 1);
  encoding.writeVarUint(payload, id);
  encoding.writeVarUint(payload, clock);
  encoding.writeVarString(payload, JSON.stringify(state));
  const frame = encoding.createEncoder();
  encoding.writeVarUint(frame, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(frame, encoding.toUint8Array(payload));
  return encoding.toUint8Array(frame);
}

export const isBinary = (f: Frame): f is Uint8Array => typeof f !== "string";
export const typeOf = (f: Frame): number =>
  typeof f === "string" ? -1 : decoding.readVarUint(decoding.createDecoder(f));
