/**
 * Dispatch-time extra-root flag. Human allow / remainder grant / yolo
 * shell is this spawn, not a file-read grant. Effect bodies read it;
 * they do not set it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const extraRootAls = new AsyncLocalStorage<boolean>();

export function runWithExtraRoot<T>(allow: boolean, fn: () => T): T {
  return extraRootAls.run(allow, fn);
}

export function extraRootAllowed(): boolean {
  return extraRootAls.getStore() === true;
}
