import { z } from "@inhuman.tools/plugin-sdk";
import { describe, expect, it } from "vitest";

import {
  encodeJsonRpcError,
  encodeJsonRpcRequest,
  isUiForm,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  type UiForm,
} from "@/protocol/rpc";
import type { PlaneSocket } from "@/yjs";

import { DaemonRpcMethod, RequestHost, RpcInternalError, UiCancelled } from "../contract.js";
import { serveJsonRpc, type RpcRequestIdentity } from "../transport/jsonrpc.js";

describe("RequestHost", () => {
  it("RequestHost parks sequential ui() and cancel throws UiCancelled", async () => {
    const host = new ProbeHost();
    const first = await host.handleRequest("probe", { label: "row" });
    if (!isUiForm(first)) throw new Error("expected parked ui");
    const second = await host.handleRequest("ui/resolve", { pending: first.pending, kind: "text", input: "alpha" });
    if (!isUiForm(second)) throw new Error("expected parked ui");
    const resolved = await host.handleRequest("ui/resolve", { pending: second.pending, kind: "text", input: "beta" });
    expect({ first, second }).toEqual({
      first: { form: "ui", pending: expect.any(String), body: '(harness/input :name "one")' },
      second: { form: "ui", pending: expect.any(String), body: '(harness/input :name "two")' },
    });
    expect(resolved).toEqual({
      label: "row",
      one: "alpha",
      two: "beta",
    });

    const cancelHost = new ProbeHost();
    const parked = await cancelHost.handleRequest("probe", {});
    expect(parked).toEqual({
      form: "ui",
      pending: expect.any(String),
      body: '(harness/input :name "one")',
    });
    await expect(
      cancelHost.handleRequest("ui/resolve", { pending: (parked as UiForm).pending, kind: "cancel" }),
    ).rejects.toBeInstanceOf(UiCancelled);
  });

  it("two concurrent ui() parks in one perform are both delivered, in order", async () => {
    const host = new ProbeHost();
    const first = await host.handleRequest("both", {});
    if (!isUiForm(first)) throw new Error("expected parked ui");
    const second = await host.handleRequest("ui/resolve", { pending: first.pending, kind: "text", input: "one" });
    if (!isUiForm(second)) throw new Error("the second park was dropped");
    const done = await host.handleRequest("ui/resolve", { pending: second.pending, kind: "text", input: "two" });
    expect({ first: first.body, second: second.body, done }).toEqual({
      first: '(harness/input :name "a")',
      second: '(harness/input :name "b")',
      done: { answers: ["one", "two"] },
    });
  });

  it("keeps a parked ui() bound to its perform when another RPC runs", async () => {
    const host = new ProbeHost();
    const first = await host.handleRequest("probe", { label: "row" });
    if (!isUiForm(first)) throw new Error("expected parked ui");
    const ping = await host.handleRequest("ping", {});
    const second = await host.handleRequest("ui/resolve", { pending: first.pending, kind: "text", input: "alpha" });
    if (!isUiForm(second)) throw new Error("expected parked ui");
    const resolved = await host.handleRequest("ui/resolve", { pending: second.pending, kind: "text", input: "beta" });
    expect({ ping, resolved }).toEqual({
      ping: { pong: true },
      resolved: { label: "row", one: "alpha", two: "beta" },
    });
  });

  it("plane close cancels a parked ui() and unknown pending after that", async () => {
    const host = new ProbeHost();
    const parked = await host.handleRequest("probe", {}, { requestId: 1, connectionId: "plane-1" });
    if (!isUiForm(parked)) throw new Error("expected parked ui");
    const reenter = await host.handleRequest("reenter", {}, { requestId: 2, connectionId: "plane-1" });
    if (!isUiForm(reenter)) throw new Error("expected parked ui");
    host.onPlaneClose("plane-1");
    await expect(
      host.handleRequest("ui/resolve", { pending: parked.pending, kind: "text", input: "alpha" }),
    ).rejects.toThrow("unknown pending");
    await expect(
      host.handleRequest("ui/resolve", { pending: reenter.pending, kind: "text", input: "alpha" }),
    ).rejects.toThrow("unknown pending");
  });

  it("a child plane close cancels the parent perform it reached", async () => {
    const parent = new ProbeHost();
    const child = new ChildOf(parent);
    const parked = await child.handleRequest("probe", {}, { requestId: 1, connectionId: "plane-c" });
    if (!isUiForm(parked)) throw new Error("expected parked ui");
    child.onPlaneClose("plane-c");
    await expect(
      child.handleRequest("ui/resolve", { pending: parked.pending, kind: "text", input: "alpha" }),
    ).rejects.toThrow("unknown pending");
  });

  it("cancel after an answer aborts the perform that is still running", async () => {
    const host = new WaitHost();
    const parked = await host.handleRequest("wait", {});
    if (!isUiForm(parked)) throw new Error("expected parked ui");
    // The client's `opened` request stays in flight while the perform waits.
    const inflight = host.handleRequest("ui/resolve", { pending: parked.pending, kind: "opened", url: "https://x" });
    await host.waiting;
    const cancelled = await host.handleRequest("ui/resolve", { pending: parked.pending, kind: "cancel" });
    expect({ cancelled, inflight: await inflight, aborted: host.aborted }).toEqual({
      cancelled: { ok: true },
      inflight: { ok: false },
      aborted: true,
    });
    await expect(host.handleRequest("ui/resolve", { pending: parked.pending, kind: "cancel" })).rejects.toThrow(
      "unknown pending",
    );
  });

  it("cancel after an answer falls through a child host to the perform's host", async () => {
    const parent = new WaitHost();
    const child = new ChildOf(parent);
    const parked = await parent.handleRequest("wait", {});
    if (!isUiForm(parked)) throw new Error("expected parked ui");
    const inflight = child.handleRequest("ui/resolve", { pending: parked.pending, kind: "opened", url: "https://x" });
    await parent.waiting;
    await child.handleRequest("ui/resolve", { pending: parked.pending, kind: "cancel" });
    expect(await inflight).toEqual({ ok: false });
  });

  it("only cancel reaches an answered pending, and only while the perform runs", async () => {
    const host = new WaitHost();
    const parked = await host.handleRequest("wait", {});
    if (!isUiForm(parked)) throw new Error("expected parked ui");
    const inflight = host.handleRequest("ui/resolve", { pending: parked.pending, kind: "opened", url: "https://x" });
    await host.waiting;
    await expect(
      host.handleRequest("ui/resolve", { pending: parked.pending, kind: "text", input: "late" }),
    ).rejects.toThrow("unknown pending");
    host.finish();
    expect(await inflight).toEqual({ ok: true });
    await expect(host.handleRequest("ui/resolve", { pending: parked.pending, kind: "cancel" })).rejects.toThrow(
      "unknown pending",
    );
  });

  it("a result that fails its output schema is -32603 on the wire, bad params stay -32602", async () => {
    class BadOutputHost extends RequestHost {
      override rpcMethods = [
        DaemonRpcMethod.define(
          "bad",
          { input: z.object({ n: z.number() }), output: z.object({ ok: z.literal(true) }) },
          // @ts-expect-error the daemon returns the wrong shape on purpose
          () => ({ ok: "nope" }),
        ),
      ];
    }
    const host = new BadOutputHost();
    await expect(host.handleRequest("bad", { n: 1 })).rejects.toBeInstanceOf(RpcInternalError);

    const texts: string[] = [];
    const socket: PlaneSocket = {
      send: () => undefined,
      sendText: (text) => void texts.push(text),
      close: () => undefined,
      onBinary: () => undefined,
      onText: () => undefined,
      onClose: () => undefined,
    };
    await serveJsonRpc(socket, host, encodeJsonRpcRequest(1, "bad", { n: 1 }), "c");
    await serveJsonRpc(socket, host, encodeJsonRpcRequest(2, "bad", { n: "x" }), "c");
    expect(texts).toEqual([
      encodeJsonRpcError(1, JSON_RPC_INTERNAL_ERROR, "Internal error: bad returned an invalid result"),
      encodeJsonRpcError(2, JSON_RPC_INVALID_PARAMS, "Invalid input: expected number, received string"),
    ]);
  });

  it("forwards request identity to parent dispatch", async () => {
    const seen: unknown[] = [];
    class ParentHost extends RequestHost {
      override async handleRequest(method: string, args: unknown, identity?: RpcRequestIdentity) {
        seen.push({ method, args, identity });
        return super.handleRequest(method, args, identity);
      }

      override rpcMethods = [
        DaemonRpcMethod.define(
          "echo",
          {
            input: z.object({ n: z.number() }),
            output: z.object({ n: z.number() }),
          },
          (input) => input,
        ),
      ];
    }
    class ChildHost extends RequestHost {
      constructor(private readonly owner: RequestHost) {
        super();
      }

      protected override get parent() {
        return this.owner;
      }
    }
    const identity: RpcRequestIdentity = { requestId: 3, connectionId: "c-1" };
    const result = await new ChildHost(new ParentHost()).handleRequest("echo", { n: 2 }, identity);
    expect({ result, seen }).toEqual({
      result: { n: 2 },
      seen: [{ method: "echo", args: { n: 2 }, identity }],
    });
  });
});

const probeInput = z.object({ label: z.string().optional() }).passthrough();
const probeOutput = z.object({
  label: z.string().optional(),
  one: z.unknown(),
  two: z.unknown(),
});

const pingInput = z.object({});
const pingOutput = z.object({ pong: z.literal(true) });

class ProbeHost extends RequestHost {
  override rpcMethods = [
    DaemonRpcMethod.define("probe", { input: probeInput, output: probeOutput }, async (args) => {
      const first = await this.ui('(harness/input :name "one")');
      const second = await this.ui('(harness/input :name "two")');
      // @ts-expect-error just quite vague type - input is basically string | undefind
      return { label: args.label, one: first.input, two: second.input };
    }),
    DaemonRpcMethod.define("both", { input: z.object({}), output: z.object({ answers: z.array(z.unknown()) }) }, async () => {
      const answers = await Promise.all([this.ui('(harness/input :name "a")'), this.ui('(harness/input :name "b")')]);
      return { answers: answers.map((answer) => (answer as { input?: unknown }).input) };
    }),
    DaemonRpcMethod.define("ping", { input: pingInput, output: pingOutput }, () => ({ pong: true as const })),
    DaemonRpcMethod.define(
      "reenter",
      { input: z.object({ input: z.string().optional() }).passthrough(), output: z.unknown() },
      (args) => (args.input == null ? { form: "ui", body: "(harness/confirm)" } : { pong: true as const }),
    ),
  ];
}

/** Parks once, then waits on the request's own abort, like a driver on a browser callback. */
class WaitHost extends RequestHost {
  aborted = false;
  readonly waiting: Promise<void>;
  #started!: () => void;
  #finish!: () => void;

  constructor() {
    super();
    this.waiting = new Promise<void>((resolve) => {
      this.#started = resolve;
    });
  }

  finish(): void {
    this.#finish();
  }

  override rpcMethods = [
    DaemonRpcMethod.define("wait", { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async () => {
      const signal = this.requestSignal();
      await this.ui('(harness/open-url :url "https://x")');
      this.#started();
      try {
        await new Promise<void>((resolve, reject) => {
          this.#finish = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { ok: true };
      } catch {
        this.aborted = signal.aborted;
        return { ok: false };
      }
    }),
  ];
}

class ChildOf extends RequestHost {
  constructor(private readonly owner: RequestHost) {
    super();
  }

  protected override get parent() {
    return this.owner;
  }
}
