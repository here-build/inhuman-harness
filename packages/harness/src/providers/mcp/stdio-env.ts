/**
 * Stdio spawn extras and stderr ring.
 *
 * Spawn env: only *extras* go into StdioClientTransport.env — the SDK always
 * merges getDefaultEnvironment() (PATH/HOME/…). Never { ...process.env }.
 *
 * stderr: always "pipe" + ring drain (unread pipe → ~64KiB deadlock).
 */
import type { ConnectionSecretsView } from "@inhuman.tools/plexus-expectations/driver";

/** Cap ring bytes (diagnostics only — never connection failure). */
const STDERR_RING_MAX = 64 * 1024;
const STDERR_TAIL_LINES = 40;

export class StderrRing {
  #chunks: Buffer[] = [];
  #bytes = 0;

  push(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) return;
    this.#chunks.push(buf);
    this.#bytes += buf.length;
    while (this.#bytes > STDERR_RING_MAX && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift()!;
      this.#bytes -= dropped.length;
    }
    if (this.#bytes > STDERR_RING_MAX && this.#chunks.length === 1) {
      const only = this.#chunks[0]!;
      const keep = only.subarray(only.length - STDERR_RING_MAX);
      this.#chunks = [Buffer.from(keep)];
      this.#bytes = keep.length;
    }
  }

  tail(maxLines = STDERR_TAIL_LINES): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    if (text.length === 0) return "";
    const lines = text.split(/\r?\n/);
    return lines.slice(-maxLines).join("\n").trimEnd();
  }

  clear(): void {
    this.#chunks = [];
    this.#bytes = 0;
  }
}

export function buildMcpChildEnvExtras(options: {
  readonly secrets?: Record<string, string>;
  readonly envForward?: readonly string[];
  readonly resolveEnv?: (names: readonly string[]) => Record<string, string>;
}): Record<string, string> {
  const extras: Record<string, string> = {};
  const tmp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (typeof tmp === "string" && tmp !== "") {
    extras.TMPDIR = tmp;
    if (process.platform === "win32") {
      extras.TEMP = tmp;
      extras.TMP = tmp;
    }
  }
  const names = options.envForward ?? [];
  if (names.length > 0) {
    const resolved =
      options.resolveEnv?.(names) ??
      Object.fromEntries(
        names.map((n) => {
          const v = process.env[n];
          return [n, typeof v === "string" ? v : ""];
        }),
      );
    for (const [k, v] of Object.entries(resolved)) {
      if (v !== "") extras[k] = v;
    }
  }
  if (options.secrets) {
    for (const [k, v] of Object.entries(options.secrets)) {
      if (v !== "") extras[k] = v;
    }
  }
  return extras;
}

/** `env_*` strips the prefix into the child; `token` / `apiKey` uppercase. */
export function secretEnv(secrets: ConnectionSecretsView): Record<string, string> {
  const out: Record<string, string> = {};
  const bag = secrets.all?.();
  if (!bag) return out;
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v === "string" && v !== "") {
      if (k.startsWith("env_")) out[k.slice(4)] = v;
      else if (k === "token" || k === "apiKey") out[k.toUpperCase()] = v;
    }
  }
  return out;
}
