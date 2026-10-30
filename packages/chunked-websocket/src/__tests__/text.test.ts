import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket as WSWebSocket } from "ws";

import { ChunkedWebSocket } from "../ChunkedWebSocket.js";
import { CHUNK_MAX_SIZE, handleChunked, RESET_SENTINEL, sendChunked, type ChunkedMessageData } from "../protocol.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** `ws` delivers text frames as Buffers; restore the browser shape. */
function normalize(data: RawData, isBinary: boolean): ArrayBuffer | string {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (!isBinary) return buf.toString("utf8");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Collects frames a sender emits, in order. */
function frames() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  return { sent, ws: { send: (d: string | Uint8Array | ArrayBuffer) => void sent.push(d) } };
}

function receiver() {
  const got: ChunkedMessageData[] = [];
  const handler = handleChunked((d) => got.push(d));
  return { got, handler };
}

function replay(handler: ReturnType<typeof handleChunked>, sent: Array<string | Uint8Array | ArrayBuffer>) {
  for (const f of sent) handler({ data: f instanceof Uint8Array ? (f.buffer as ArrayBuffer) : f });
}

/** Multi-byte text: 2-byte, 3-byte and 4-byte (surrogate pair) characters. */
function bigText(bytes: number): string {
  const unit = "aé€😀";
  return unit.repeat(Math.ceil(bytes / new TextEncoder().encode(unit).byteLength));
}

describe("text frames", () => {
  it("delivers short text unchanged as a string", () => {
    const { sent, ws } = frames();
    sendChunked('{"jsonrpc":"2.0","id":1}', ws);
    expect(sent).toEqual(['{"jsonrpc":"2.0","id":1}']);

    const { got, handler } = receiver();
    replay(handler, sent);
    expect(got).toEqual(['{"jsonrpc":"2.0","id":1}']);
  });

  it("swallows only the reset sentinel", () => {
    const { got, handler } = receiver();
    handler({ data: RESET_SENTINEL });
    handler({ data: "hello" });
    expect(got).toEqual(["hello"]);
  });

  it("marks text batches with kind text and binary batches with kind binary", () => {
    const text = frames();
    sendChunked(bigText(CHUNK_MAX_SIZE + 10), text.ws);
    expect(JSON.parse((text.sent[0] as string).split("#")[1]!).kind).toBe("text");
    expect(JSON.parse((text.sent.at(-1) as string).split("#")[1]!).kind).toBe("text");

    const bin = frames();
    sendChunked(new Uint8Array(CHUNK_MAX_SIZE + 1).buffer, bin.ws);
    expect(JSON.parse((bin.sent[0] as string).split("#")[1]!).kind).toBe("binary");
  });

  it("does not chunk a string whose UTF-8 size fits", () => {
    const { sent, ws } = frames();
    // 400k chars * 2 bytes = 800k bytes, but length * 3 > limit.
    const s = "é".repeat(400_000);
    sendChunked(s, ws);
    expect(sent).toEqual([s]);
  });

  it("round-trips text over the limit, multi-byte included, as a string", () => {
    const text = bigText(2_500_000);
    const { sent, ws } = frames();
    sendChunked(text, ws);
    expect(sent.length).toBeGreaterThan(3);

    const { got, handler } = receiver();
    replay(handler, sent);
    expect(got).toHaveLength(1);
    expect(typeof got[0]).toBe("string");
    expect(got[0] === text).toBe(true);
  });

  it("interleaves binary and text, chunked and not", () => {
    const bigBin = new Uint8Array(CHUNK_MAX_SIZE + 5).fill(7);
    const big = bigText(CHUNK_MAX_SIZE + 100);
    const { sent, ws } = frames();
    sendChunked("a", ws);
    sendChunked(new Uint8Array([1, 2, 3]).buffer, ws);
    sendChunked(big, ws);
    sendChunked(bigBin.buffer, ws);
    sendChunked("b", ws);

    const { got, handler } = receiver();
    replay(handler, sent);
    expect(got).toHaveLength(5);
    expect(got[0]).toBe("a");
    expect(new Uint8Array(got[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(got[2] === big).toBe(true);
    expect(new Uint8Array(got[3] as ArrayBuffer)).toEqual(bigBin);
    expect(got[4]).toBe("b");
  });

  it("decodes a marker without kind as binary", () => {
    const payload = new Uint8Array([104, 105]); // "hi"
    const marker = (type: "start" | "end") => `y-pk-batch#${JSON.stringify({ id: "old", type, size: 2, count: 1 })}`;
    const { got, handler } = receiver();
    handler({ data: marker("start") });
    handler({ data: payload.buffer });
    handler({ data: marker("end") });
    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(got[0] as ArrayBuffer)).toEqual(payload);
  });

  it("drops a text batch cut by reset and recovers on the next one", () => {
    const first = frames();
    sendChunked(bigText(CHUNK_MAX_SIZE * 2 + 1), first.ws);
    const { got, handler } = receiver();
    // start marker, first chunk, then reset, then the orphan rest.
    replay(handler, first.sent.slice(0, 2));
    handler({ data: RESET_SENTINEL });
    replay(handler, first.sent.slice(2));
    expect(got).toEqual([]);

    // Plain text still flows while draining is over; a fresh batch decodes.
    const next = frames();
    const text = bigText(CHUNK_MAX_SIZE + 1);
    sendChunked(text, next.ws);
    replay(handler, next.sent);
    expect(got).toHaveLength(1);
    expect(got[0] === text).toBe(true);
  });

  it("delivers plain text that arrives while draining", () => {
    const { sent, ws } = frames();
    sendChunked(bigText(CHUNK_MAX_SIZE + 1), ws);
    const { got, handler } = receiver();
    replay(handler, sent.slice(0, 2));
    handler({ data: RESET_SENTINEL });
    handler({ data: "rpc" });
    expect(got).toEqual(["rpc"]);
  });
});

describe("text over a socket", () => {
  it("carries text and binary on one connection, both over the limit", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    const port = (wss.address() as { port: number }).port;

    wss.on("connection", (raw: WSWebSocket) => {
      const server = new ChunkedWebSocket(raw);
      raw.on("message", (d, isBinary) => server.feed(normalize(d, isBinary)));
      server.addEventListener("message", (e) => server.send(e.data as string));
    });

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());
    const echoes: Array<string | ArrayBuffer> = [];
    client.addEventListener("message", (e) => echoes.push(e.data));
    await new Promise<void>((resolve) => client.addEventListener("open", () => resolve()));

    const text = bigText(1_800_000);
    const bin = new Uint8Array(1_200_000).fill(9);
    client.send("short");
    client.send(text);
    client.send(bin);

    await new Promise<void>((resolve) => {
      const tick = () => (echoes.length >= 3 ? resolve() : void setTimeout(tick, 10));
      tick();
    });
    expect(echoes[0]).toBe("short");
    expect(echoes[1] === text).toBe(true);
    expect(new Uint8Array(echoes[2] as ArrayBuffer)).toEqual(bin);
  });
});

describe("Node global WebSocket", () => {
  it("sends an Authorization header through the undici init object", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    const port = (wss.address() as { port: number }).port;
    const seen = new Promise<string | undefined>((resolve) =>
      wss.on("connection", (_s, req) => resolve(req.headers.authorization)),
    );

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: "Bearer tok" } });
    cleanups.push(() => client.close());
    expect(await seen).toBe("Bearer tok");
  });
});

describe("close event", () => {
  it("carries the code and reason where the runtime has no CloseEvent (Node 22)", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (raw) => raw.close(4503, "offline"));

    const client = new ChunkedWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());
    const closed = await new Promise<Event>((resolve) => client.addEventListener("close", resolve));
    expect(closed).toMatchObject({ code: 4503, reason: "offline" });
  });
});
