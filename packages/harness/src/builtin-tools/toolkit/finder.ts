/**
 * One FileFinder per workspace root. Observe tools (glob, fff_search, grep)
 * share this index — not a second JS walker.
 */
import { realpath } from "node:fs/promises";

import { FileFinder } from "@ff-labs/fff-node";
import invariant from "tiny-invariant";

import { errnoCode } from "../errno.js";

const finders = new Map<string, FileFinder>();
const booting = new Map<string, Promise<FileFinder>>();

async function rootKey(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new Error(`no such project root: ${root}`);
    }
    throw error;
  }
}

/** Process-local finder for `root`. Scan must finish before the first search. */
export async function finderFor(root: string, signal?: AbortSignal): Promise<FileFinder> {
  invariant(FileFinder.isAvailable(), "fff native binary is not available on this platform");
  const key = await rootKey(root);
  const live = finders.get(key);
  if (live !== undefined && !live.isDestroyed) return live;

  let pending = booting.get(key);
  if (pending === undefined) {
    pending = boot(key, signal);
    booting.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    booting.delete(key);
  }
}

async function boot(key: string, signal?: AbortSignal): Promise<FileFinder> {
  const created = FileFinder.create({
    basePath: key,
    aiMode: true,
  });
  if (!created.ok) throw new Error(`fff: ${created.error}`);
  const finder = created.value;
  try {
    if (signal?.aborted) throw new Error("fff scan aborted");
    const scanned = await finder.waitForScan(15_000);
    if (signal?.aborted) throw new Error("fff scan aborted");
    if (!scanned.ok) throw new Error(`fff scan: ${scanned.error}`);
    finders.set(key, finder);
    return finder;
  } catch (error) {
    finder.destroy();
    throw error;
  }
}
