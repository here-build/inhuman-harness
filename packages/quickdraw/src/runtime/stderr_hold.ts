/**
 * Alt-screen owns the TTY. stderr writes during occupy land in the layout
 * and die with leave-alt (`?1049l` discards that buffer). Hold the bytes;
 * {@link StderrHold.release} AFTER leave-alt so they print on the primary
 * screen.
 *
 * Monkey-patches `stream.write` only. fd-2 writes (inherited worker stderr)
 * bypass this — callers that spawn workers must pipe stderr onto this stream.
 */
import type { Writable } from "node:stream";

export type StderrHold = {
  /** Restore the original write and flush. Idempotent. After leave-alt. */
  release(): void;
};

type WriteFn = Writable["write"];

export function holdStderr(stream: Writable): StderrHold {
  const chunks: Buffer[] = [];
  const original = stream.write;
  let released = false;

  stream.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ): boolean => {
    const enc = typeof encoding === "string" ? encoding : "utf8";
    const done = typeof encoding === "function" ? encoding : cb;
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc) : Buffer.from(chunk));
    done?.();
    return true;
  }) as WriteFn;

  return {
    release() {
      if (released) return;
      released = true;
      stream.write = original;
      for (const chunk of chunks) stream.write(chunk);
    },
  };
}
