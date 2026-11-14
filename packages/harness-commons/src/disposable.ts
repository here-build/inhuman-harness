/**
 * [Symbol.dispose] marks the instance disposed once, then calls `dispose`.
 * Subclasses implement `dispose` and leave `[Symbol.dispose]` alone.
 * A subclass `#dispose` is a different method; this class cannot call it.
 *
 * `@disposableGuard` throws once `disposed` is set. An override of a guarded
 * method has to carry the decorator again.
 */
export abstract class DisposableClass implements Disposable {
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.dispose();
  }

  protected abstract dispose(): void;
}

export function disposableGuard<This extends { readonly disposed: boolean }, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): (this: This, ...args: Args) => Result {
  const name = String(context.name);
  return function (this: This, ...args: Args): Result {
    if (this.disposed) throw new Error(`${name}: disposed`);
    return method.call(this, ...args);
  };
}

/**
 * [Symbol.asyncDispose] marks the instance disposed once, coalesces concurrent callers
 * onto a single in-flight teardown promise, and calls `disposeAsync`.
 */
export abstract class AsyncDisposableClass implements AsyncDisposable {
  #disposed = false;
  #disposing: Promise<void> | null = null;

  get disposed(): boolean {
    return this.#disposed;
  }

  get disposing(): boolean {
    return this.#disposing !== null && !this.#disposed;
  }

  protected markDisposed(): boolean {
    if (this.#disposed) return false;
    this.#disposed = true;
    return true;
  }

  [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposing ??= (async () => {
      try {
        await this.disposeAsync();
      } finally {
        this.#disposed = true;
        this.#disposing = null;
      }
    })();
    return this.#disposing;
  }

  protected abstract disposeAsync(): Promise<void>;
}
