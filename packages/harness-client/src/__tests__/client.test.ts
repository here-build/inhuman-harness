import { describe, expect, it } from "vitest";

import {
  createHarnessClient,
  HarnessClosedError,
  HarnessParkError,
  HarnessRpcError,
  harnessUpgradePath,
  harnessUpgradeUrl,
  type Transport,
} from "../index.js";

class FakeTransport implements Transport {
  readonly sent: Array<{ id: number; method: string; params: unknown }> = [];
  readonly #messages = new Set<(text: string) => void>();
  readonly #closes = new Set<(cause?: Error) => void>();

  send(text: string): void {
    const frame = JSON.parse(text) as { jsonrpc: string; id: number; method: string; params: unknown };
    expect(frame.jsonrpc).toBe("2.0");
    this.sent.push({ id: frame.id, method: frame.method, params: frame.params });
  }

  onMessage(listener: (text: string) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: (cause?: Error) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close(): void {
    this.drop();
  }

  /** The daemon's reply to the n-th request sent. */
  reply(index: number, body: { result: unknown } | { error: { code: number; message: string; data?: unknown } }) {
    const request = this.sent[index];
    if (request === undefined) throw new Error(`no request #${index}`);
    this.raw(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }));
  }

  raw(text: string): void {
    for (const listener of this.#messages) listener(text);
  }

  drop(cause?: Error): void {
    for (const listener of this.#closes) listener(cause);
  }
}

/** Let the client's microtasks run so a request is on the wire. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("harness client", () => {
  it("a typed call goes out under its wire name with by-name params and resolves with the result", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport });

    const call = client.session.kv.set({ key: "model", value: "m1" });
    await tick();
    expect(transport.sent).toEqual([
      { id: expect.any(Number), method: "kv/set", params: { key: "model", value: "m1" } },
    ]);
    transport.reply(0, { result: { ok: true } });
    const result: { ok: true } = await call;
    expect(result).toEqual({ ok: true });

    // A bare method keeps its wire name, whatever its place in the tree.
    const turn = client.session.turn.send({ prompt: "hi" });
    const namespaced = client.session.turn.cancel({ turnId: "t1" });
    await tick();
    expect(transport.sent.slice(1).map((frame) => frame.method)).toEqual(["turn", "turn/cancel"]);
    transport.reply(1, { result: { ok: true } });
    transport.reply(2, { result: { ok: true } });
    await Promise.all([turn, namespaced]);

    // @ts-expect-error `value` is required by kv/set
    void client.session.kv.set({ key: "model" }).catch(() => undefined);
  });

  it("maps a JSON-RPC error to HarnessRpcError with code, message and data", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport });
    const call = client.kernel.connect.get({ id: "nope" });
    await tick();
    transport.reply(0, { error: { code: -32_602, message: "unknown connection nope", data: { id: "nope" } } });
    const error = await call.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(HarnessRpcError);
    expect(error).toMatchObject({ code: -32_602, message: "unknown connection nope", data: { id: "nope" } });
  });

  it("a park is answered through onPark and the original call resolves with the resumed result", async () => {
    const transport = new FakeTransport();
    const seen: unknown[] = [];
    const client = createHarnessClient({
      transport,
      onPark: (form) => {
        seen.push(form);
        return { kind: "text", input: "https://example.test/v1" };
      },
    });

    const call = client.kernel.connect.adopt({ driver: "openai-compat" });
    await tick();
    const form = { form: "ui", pending: "p-1", body: '(harness/input :name "url")' };
    transport.reply(0, { result: form });
    await tick();
    expect(seen).toEqual([form]);
    expect(transport.sent[1]).toMatchObject({
      method: "ui/resolve",
      params: { pending: "p-1", kind: "text", input: "https://example.test/v1" },
    });
    transport.reply(1, { result: { id: "example-test" } });
    // The park form is not part of the resolved type.
    const adopted: { id: string } | { ok: false } = await call;
    expect(adopted).toEqual({ id: "example-test" });
  });

  it("a park can park again", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport, onPark: () => ({ kind: "accept" }) });
    const call = client.kernel.connect.drop({ id: "c1" });
    await tick();
    transport.reply(0, { result: { form: "ui", pending: "p-1", body: "(harness/confirm)" } });
    await tick();
    transport.reply(1, { result: { form: "ui", pending: "p-2", body: "(harness/confirm)" } });
    await tick();
    expect(transport.sent.map((frame) => frame.method)).toEqual(["connect/drop", "ui/resolve", "ui/resolve"]);
    transport.reply(2, { result: { ok: true } });
    expect(await call).toEqual({ ok: true });
  });

  it("without onPark a park rejects with HarnessParkError carrying the form", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport });
    const call = client.kernel.connect.login({ id: "c1" });
    await tick();
    const form = { form: "ui", pending: "p-9", body: "(harness/open-url)" };
    transport.reply(0, { result: form });
    const error = await call.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(HarnessParkError);
    expect((error as HarnessParkError).form).toEqual(form);
  });

  it("an onPark that throws cancels the park and rejects the call", async () => {
    const transport = new FakeTransport();
    const boom = new Error("user walked away");
    const client = createHarnessClient({
      transport,
      onPark: () => {
        throw boom;
      },
    });
    const call = client.kernel.connect.login({ id: "c1" });
    const outcome = call.catch((error: unknown) => error);
    await tick();
    transport.reply(0, { result: { form: "ui", pending: "p-3", body: "(harness/open-url)" } });
    await tick();
    expect(transport.sent[1]).toMatchObject({ method: "ui/resolve", params: { pending: "p-3", kind: "cancel" } });
    transport.reply(1, { result: { ok: false } });
    expect(await outcome).toBe(boom);
  });

  it("closing the connection rejects every call in flight and every later call", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport });
    const first = client.session.kv.clear({ key: "a" });
    const second = client.kernel.connect.list({});
    const outcomes = Promise.allSettled([first, second]);
    await tick();
    transport.drop(new Error("socket reset"));
    const settled = await outcomes;
    expect(settled.map((row) => row.status)).toEqual(["rejected", "rejected"]);
    for (const row of settled) {
      expect(row.status === "rejected" && row.reason).toBeInstanceOf(HarnessClosedError);
    }
    await expect(client.session.kv.clear({ key: "b" })).rejects.toBeInstanceOf(HarnessClosedError);
  });

  it("an aborted signal rejects locally, sends nothing more, and a late reply is ignored", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport });
    const controller = new AbortController();
    const call = client.session.compact({}, { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.sent).toHaveLength(1);
    transport.reply(0, { result: { ok: true, compacted: false } });

    const pre = new AbortController();
    pre.abort();
    await expect(client.session.compact({}, { signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.sent).toHaveLength(1);
  });

  it("ignores frames that are not replies to a pending call", async () => {
    const transport = new FakeTransport();
    const client = createHarnessClient({ transport });
    const call = client.session.resident.set({ resident: true });
    await tick();
    transport.raw("not json");
    transport.raw(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } }));
    transport.raw(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
    transport.reply(0, { result: { ok: true } });
    expect(await call).toEqual({ ok: true });
  });
});

describe("upgrade urls", () => {
  it("builds the path each host is routed by", () => {
    expect(harnessUpgradePath({ host: "kernel" })).toBe("/kernel");
    expect(harnessUpgradePath({ host: "project", path: "/work/a b" })).toBe("/project?path=%2Fwork%2Fa+b");
    expect(harnessUpgradePath({ host: "session", sessionId: "s1" })).toBe("/session?sessionId=s1");
    expect(harnessUpgradePath({ host: "session", path: "/w", sessionId: "s1" })).toBe(
      "/session?path=%2Fw&sessionId=s1",
    );
    expect(harnessUpgradePath({ host: "session", path: "/w" })).toBe("/session?path=%2Fw");
    expect(harnessUpgradeUrl("ws://h:1/", { host: "kernel" })).toBe("ws://h:1/kernel");
  });
});
