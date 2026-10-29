/**
 * Display-only shfmt reprint of a shell command. Never rewrite argsJson.
 * sh-syntax instantiates WASM per print and is async — cache the result;
 * parse failure is identity. File print's trailing newline is stripped.
 */
import { observable, runInAction } from "mobx";
import { print } from "sh-syntax";

const generation = observable.box(0);
const cache = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

export function shellFormatGeneration(): number {
  return generation.get();
}

/** Cached reprint, or `src` until WASM print settles / if parse fails. */
export function formatShellCommand(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  generation.get(); // MobX subscribe — WASM settle increments this so reprint rerenders. Not a dead call.
  schedule(src);
  return src;
}

export async function formatShellCommandReady(src: string): Promise<string> {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  schedule(src);
  await pending.get(src);
  return cache.get(src) ?? src;
}

function schedule(src: string): void {
  if (src === "" || pending.has(src) || cache.has(src)) return;
  const work = (async () => {
    try {
      const out = await print(src);
      const formatted = out.replaceAll(/\n+$/g, "");
      const next = formatted === "" ? src : formatted;
      cache.set(src, next);
      if (next !== src) {
        runInAction(() => generation.set(generation.get() + 1));
      }
    } catch {
      cache.set(src, src);
    } finally {
      pending.delete(src);
    }
  })();
  pending.set(src, work);
}
