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

export function disposableGuard<This extends DisposableClass, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): (this: This, ...args: Args) => Result {
  const name = String(context.name);
  return function (this: This, ...args: Args): Result {
    if (this.disposed) throw new Error(`${name}: disposed`);
    return method.call(this, ...args);
  };
}
