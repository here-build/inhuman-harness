import { describe, expect, it } from "vitest";

import { AsyncDisposableClass, DisposableClass, disposableGuard } from "../disposable.js";

class SyncResource extends DisposableClass {
  calls = 0;

  @disposableGuard
  ping(): string {
    return "pong";
  }

  protected dispose(): void {
    this.calls += 1;
  }
}

class AsyncResource extends AsyncDisposableClass {
  calls = 0;
  readonly release: () => void;
  readonly #gate: Promise<void>;

  constructor() {
    super();
    let resolve!: () => void;
    this.#gate = new Promise<void>((r) => {
      resolve = r;
    });
    this.release = resolve;
  }

  @disposableGuard
  ping(): string {
    return "pong";
  }

  markNow(): boolean {
    return this.markDisposed();
  }

  protected async disposeAsync(): Promise<void> {
    this.calls += 1;
    await this.#gate;
  }
}

describe("DisposableClass and AsyncDisposableClass", () => {
  it("guards sync methods and makes Symbol.dispose idempotent", () => {
    const resource = new SyncResource();
    expect(resource.ping()).toBe("pong");
    expect(resource.disposed).toBe(false);

    resource[Symbol.dispose]();
    resource[Symbol.dispose]();

    expect(resource.disposed).toBe(true);
    expect(resource.calls).toBe(1);
    expect(() => resource.ping()).toThrow("ping: disposed");
  });

  it("coalesces concurrent Symbol.asyncDispose callers and transitions disposing -> disposed", async () => {
    const resource = new AsyncResource();
    expect(resource.ping()).toBe("pong");
    expect(resource.disposing).toBe(false);
    expect(resource.disposed).toBe(false);

    const p1 = resource[Symbol.asyncDispose]();
    const p2 = resource[Symbol.asyncDispose]();
    expect(p1).toBe(p2);
    expect(resource.disposing).toBe(true);
    expect(resource.disposed).toBe(false);
    expect(resource.calls).toBe(1);

    resource.release();
    await Promise.all([p1, p2]);

    expect(resource.disposing).toBe(false);
    expect(resource.disposed).toBe(true);
    expect(() => resource.ping()).toThrow("ping: disposed");

    await resource[Symbol.asyncDispose]();
    expect(resource.calls).toBe(1);
  });

  it("markDisposed supports synchronous fallback without running disposeAsync afterwards", async () => {
    const resource = new AsyncResource();
    expect(resource.markNow()).toBe(true);
    expect(resource.markNow()).toBe(false);
    expect(resource.disposed).toBe(true);
    await resource[Symbol.asyncDispose]();
    expect(resource.calls).toBe(0);
  });
});
