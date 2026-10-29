/**
 * Error whose `static invariant` throws `new this(...ctorArgs)`.
 * A function in the first slot runs only on failure and replaces that
 * argument. Not on ErrorConstructor — a receiver with extra constructor
 * args (`(code, message)`) does not fight `(condition, message?)`.
 */
export class ErrorWithInvariant extends Error {
  static invariant<T extends new (message?: string, ...args: any[]) => ErrorWithInvariant>(
    this: T,
    condition: unknown,
    message?: string | (() => string),
    ...args: any[]
  ): asserts condition;
  static invariant<T extends new (...args: any[]) => ErrorWithInvariant>(
    this: T,
    condition: unknown,
    ...args: ConstructorParameters<T>
  ): asserts condition;
  static invariant(
    this: new (...args: any[]) => ErrorWithInvariant,
    condition: unknown,
    ...args: any[]
  ): asserts condition {
    if (condition) return;
    const [head, ...rest] = args;
    throw new this(...(typeof head === "function" ? [head(), ...rest] : args));
  }
}
