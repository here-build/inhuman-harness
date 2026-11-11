import { handleChunked, sendChunked } from "@inhuman.tools/chunked-websocket";

export type Frame = string | Uint8Array;

export function presenceFrame(id: number, clock: number, state: Record<string, unknown> | null): string {
  return JSON.stringify({
    kind: "presence/update",
    entries: [[id, state, clock]],
  });
}

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

  protected wake(): void {
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
        const done = (): void => {
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

/** Browser-side reactivity plane peer: subscribes to a shape on open, tracks deltas and presence. */
export class BrowserPlanePeer extends Peer {
  readonly state = new Map<string, unknown>();
  synced = false;
  presence: Array<Record<string, unknown>> = [];
  pings = 0;

  constructor(ws: WebSocket, readonly subscriptionId = "sub-1") {
    super(ws);
    this.handle((f) => {
      if (typeof f !== "string") return false;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(f) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (typeof parsed.kind !== "string") return false;
      switch (parsed.kind) {
        case "shape/delta": {
          if (parsed.reset === true) this.state.clear();
          if (Array.isArray(parsed.upserts)) {
            for (const row of parsed.upserts) {
              if (row && typeof row === "object" && "key" in row) {
                const r = row as { key: string; value: unknown };
                this.state.set(r.key, r.value);
              }
            }
          }
          if (Array.isArray(parsed.deletes)) {
            for (const key of parsed.deletes) {
              if (typeof key === "string") this.state.delete(key);
            }
          }
          if (parsed.upToDate === true) this.synced = true;
          return true;
        }
        case "presence/update":
        case "presence/state":
          this.presence.push(parsed);
          return true;
        case "ping":
          this.pings++;
          return true;
        case "pong":
          return true;
        default:
          return false;
      }
    });

    this.send(
      JSON.stringify({
        kind: "shape/subscribe",
        subscriptionId: this.subscriptionId,
        lane: "scope_nodes",
        params: { scopeId: "kernel" },
      }),
    );
  }

  /** Attempt an unauthorized client-side shape/delta write (must be dropped by relay). */
  forgeDelta(key: string, value: unknown): void {
    this.send(
      JSON.stringify({
        kind: "shape/delta",
        subscriptionId: this.subscriptionId,
        lane: "scope_nodes",
        offset: 999,
        reset: false,
        upserts: [{ key, value }],
        deletes: [],
        upToDate: true,
      }),
    );
  }
}

/** Daemon-side reactivity plane peer: serves SQLite shape subscriptions and records presence/queries. */
export class DaemonPlanePeer extends Peer {
  readonly state = new Map<string, unknown>();
  readonly subscriptions = new Map<string, string>();
  subscribes = 0;
  unsubscribes = 0;
  queries = 0;
  presence: Array<Record<string, unknown>> = [];
  private offset = 0;

  constructor(ws: WebSocket) {
    super(ws);
    this.handle((f) => {
      if (typeof f !== "string") return false;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(f) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (typeof parsed.kind !== "string") return false;
      switch (parsed.kind) {
        case "shape/subscribe": {
          const subId = String(parsed.subscriptionId ?? "");
          const lane = String(parsed.lane ?? "scope_nodes");
          this.subscribes++;
          this.subscriptions.set(subId, lane);
          this.send(
            JSON.stringify({
              kind: "shape/delta",
              subscriptionId: subId,
              lane,
              offset: this.offset,
              reset: true,
              upserts: [...this.state.entries()].map(([key, value]) => ({ key, value })),
              deletes: [],
              upToDate: true,
            }),
          );
          return true;
        }
        case "shape/unsubscribe": {
          const subId = String(parsed.subscriptionId ?? "");
          this.unsubscribes++;
          this.subscriptions.delete(subId);
          return true;
        }
        case "presence/update":
          this.presence.push(parsed);
          return true;
        case "presence/query":
          this.queries++;
          return true;
        default:
          return false;
      }
    });
  }

  setState(key: string, value: unknown): void {
    this.offset++;
    this.state.set(key, value);
    for (const [subId, lane] of this.subscriptions) {
      this.send(
        JSON.stringify({
          kind: "shape/delta",
          subscriptionId: subId,
          lane,
          offset: this.offset,
          reset: false,
          upserts: [{ key, value }],
          deletes: [],
          upToDate: true,
        }),
      );
    }
  }
}
