import { expect, test } from "vitest";

import { DisposableClass, disposableGuard } from "../disposable.js";

class Box extends DisposableClass {
  releases = 0;
  value = 1;

  protected dispose(): void {
    this.releases += 1;
    this.value = 0;
  }

  @disposableGuard
  read(): number {
    return this.value;
  }

  @disposableGuard
  fail(): never {
    throw new Error("nope");
  }
}

test("dispose runs the hook once and the guard refuses later calls", () => {
  const box = new Box();
  expect(box.read()).toBe(1);
  expect(() => box.fail()).toThrow("nope");
  box[Symbol.dispose]();
  box[Symbol.dispose]();
  expect({ disposed: box.disposed, releases: box.releases, value: box.value }).toEqual({
    disposed: true,
    releases: 1,
    value: 0,
  });
  expect(() => box.read()).toThrow("read: disposed");
});

test("using disposes at the end of the block", () => {
  let box: Box;
  {
    using inner = new Box();
    box = inner;
    expect(inner.disposed).toBe(false);
  }
  expect(box.disposed).toBe(true);
  expect(box.releases).toBe(1);
});
