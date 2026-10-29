import { fromBase64, parseLog, toBase64 } from "./doc-log.js";
import { docs } from "./host.js";
import type { DocCache } from "../../harness-web-app/src/client/doc-cache.js";

/** The device cache, or null when the installed binary predates the native store. */
export function deviceDocCache(): DocCache | null {
  const native = docs();
  if (native == null) return null;
  // A superseded attach and its successor ask for the same key at once; decode it once.
  const reading = new Map<string, Promise<readonly Uint8Array[] | null>>();
  const read = async (key: string): Promise<readonly Uint8Array[] | null> => {
    try {
      const text = await native.read(key);
      if (text == null) return null;
      const records = parseLog(fromBase64(text));
      return records.length === 0 ? null : records;
    } catch {
      return null;
    }
  };
  return {
    load(key) {
      const shared = reading.get(key) ?? read(key);
      reading.set(key, shared);
      void shared.finally(() => reading.delete(key));
      return shared;
    },
    append(key, update) {
      void native.append(key, toBase64(update)).catch(() => undefined);
    },
    replace(key, state) {
      void native.replace(key, toBase64(state)).catch(() => undefined);
    },
    drop(key) {
      void native.drop(key).catch(() => undefined);
    },
  };
}
