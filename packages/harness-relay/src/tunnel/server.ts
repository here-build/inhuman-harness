/**
 * Server half of the reverse tunnel, adapted from here.build/inhuman/saas/reverse-tunnel/src/server.ts
 * (the owner relicenses it MIT). It is no longer a Durable Object of its own: MachineDO owns the
 * control socket and hands this class the frames. Calls live in memory only; the runtime does not
 * hibernate a DO with a request in flight.
 */
import { decodeChunk, decodeNodeFrame, encodeServerFrame, type CallId } from "./protocol.js";

/** Request headers worth sending to the machine. Everything else (cookies, x-relay-*, cf-*) stays here. */
const FORWARD = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
  "user-agent",
]);
/** Response headers the machine must not set on our origin. */
const DROP = new Set(["set-cookie", "set-cookie2", "connection", "keep-alive", "transfer-encoding", "upgrade"]);
const NULL_BODY = new Set([101, 204, 205, 304]);

/** No head within this long: the machine is wedged, not slow. */
export const HEAD_TIMEOUT_MS = 30_000;

interface Pending {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  resolveHead(res: Response): void;
  rejectHead(err: Error): void;
  headSettled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class TunnelServer {
  private readonly pending = new Map<CallId, Pending>();
  private nextId = 1;

  /** `send` writes one text frame to the control socket and throws if it is gone. */
  constructor(private readonly send: (frame: string) => void) {}

  get inflight(): number {
    return this.pending.size;
  }

  /** Forward one GET/HEAD to the machine. `target` is the path after /m/<id>, with query. */
  async call(request: Request, target: string): Promise<Response> {
    const id = this.nextId++;
    if (this.nextId > 0xff_ff_ff_ff) this.nextId = 1;
    const headers: [string, string][] = [...request.headers].filter(([k]) => FORWARD.has(k.toLowerCase()));

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => this.abort(id),
    });
    const head = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => this.abort(id, "machine did not answer"), HEAD_TIMEOUT_MS);
      this.pending.set(id, {
        stream,
        controller,
        resolveHead: resolve,
        rejectHead: reject,
        headSettled: false,
        timer,
      });
    });

    try {
      this.send(encodeServerFrame({ t: "req", id, method: request.method, url: target, headers }));
    } catch (error) {
      this.drop(id);
      return new Response(`tunnel send failed: ${message(error)}`, { status: 502 });
    }
    request.signal.addEventListener("abort", () => this.abort(id), { once: true });
    try {
      return await head;
    } catch (error) {
      return new Response(`tunnel error: ${message(error)}`, { status: 502 });
    }
  }

  /** One text frame from the node. */
  onText(text: string): void {
    const frame = decodeNodeFrame(text);
    const p = this.pending.get(frame.id);
    if (p === undefined) return;
    switch (frame.t) {
      case "head": {
        if (p.headSettled) return;
        p.headSettled = true;
        clearTimeout(p.timer);
        const headers = new Headers();
        for (const [k, v] of frame.headers) if (!DROP.has(k.toLowerCase())) headers.append(k, v);
        const bodyless = NULL_BODY.has(frame.status);
        try {
          p.resolveHead(
            new Response(bodyless ? null : p.stream, {
              status: frame.status,
              statusText: frame.statusText,
              headers,
            }),
          );
        } catch {
          // A status the Response constructor refuses (e.g. 1xx).
          this.fail(frame.id, new Error(`bad status ${frame.status}`));
        }
        if (bodyless) this.finish(frame.id);
        break;
      }
      case "end":
        this.finish(frame.id);
        break;
      case "err":
        this.fail(frame.id, new Error(frame.message));
        break;
    }
  }

  /** One binary body chunk from the node. */
  onBinary(buf: ArrayBuffer): void {
    if (buf.byteLength < 4) return;
    const { id, bytes } = decodeChunk(buf);
    const p = this.pending.get(id);
    if (p === undefined) return;
    try {
      p.controller.enqueue(bytes);
    } catch {
      // Stream already closed or cancelled.
    }
  }

  /** The control socket dropped: every call riding it fails. */
  failAll(reason: string): void {
    for (const id of this.pending.keys()) this.fail(id, new Error(reason));
  }

  private finish(id: CallId): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.drop(id);
    try {
      p.controller.close();
    } catch {
      // Already closed.
    }
  }

  private fail(id: CallId, err: Error): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.drop(id);
    if (!p.headSettled) {
      p.headSettled = true;
      p.rejectHead(err);
      return;
    }
    try {
      p.controller.error(err);
    } catch {
      // Already closed.
    }
  }

  /** The caller went away (or the node stalled): tell the node, forget the call. */
  private abort(id: CallId, why = "caller aborted"): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.drop(id);
    if (!p.headSettled) {
      p.headSettled = true;
      p.rejectHead(new Error(why));
    }
    try {
      this.send(encodeServerFrame({ t: "cancel", id }));
    } catch {
      // Socket gone; the node cleans up on its own close.
    }
  }

  private drop(id: CallId): void {
    const p = this.pending.get(id);
    if (p !== undefined) clearTimeout(p.timer);
    this.pending.delete(id);
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
