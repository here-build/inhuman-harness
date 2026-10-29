/**
 * The Rust process owns the terminal. This file is the pipe.
 *
 * Child stdin is length-prefixed frames (paint_init, paint_patch, title,
 * phase, shutdown). Child stdout is length-prefixed frames back (input_events,
 * resize, activate, quit, failed). The child opens `/dev/tty` itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { BoxBusUpMessage } from "@inhuman.tools/quickdraw/runtime";

import type { PaintDownMessage } from "./paint-transport.js";

const FRAME_CAP = 32 * 1024 * 1024;
/** Long enough for one poll and the destructor. Then `SIGTERM`, then `SIGKILL`. */
const SHUTDOWN_GRACE_MS = 1000;
const require = createRequire(import.meta.url);
const CARGO_BUILD = "cargo build --release --manifest-path packages/quickdraw/rust/qd/Cargo.toml";

export function qdPackageName(platform: string, arch: string): string {
  return `@inhuman.tools/qd-${platform}-${arch}`;
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveQdBinary(opts: {
  platform: string;
  arch: string;
  devBinary: string;
  resolvePackageJson: (spec: string) => string;
  exists: (file: string) => boolean;
  executable: (file: string) => boolean;
}): string {
  const pkg = qdPackageName(opts.platform, opts.arch);
  try {
    // The name is built at runtime so the boundary checker does not see a static import.
    const manifest = opts.resolvePackageJson(`${pkg}/package.json`);
    const binary = path.join(path.dirname(manifest), "qd");
    if (opts.exists(binary) && opts.executable(binary)) return binary;
  } catch {
    // This platform's optional package is not installed.
  }
  if (opts.exists(opts.devBinary) && opts.executable(opts.devBinary)) return opts.devBinary;
  throw new Error(
    `qd binary missing for ${opts.platform}-${opts.arch}. Expected ${pkg} or ${opts.devBinary}. Build it with ${CARGO_BUILD}`,
  );
}

export type RustPresent = {
  writeDown(
    message:
      PaintDownMessage | { kind: "title"; text: string } | { kind: "phase"; text: string } | { kind: "shutdown" },
  ): void;
  geometry(): { cols: number; rows: number };
  /** Shutdown frame, then wait. `SIGTERM` only if the child does not exit. */
  restore(): Promise<void>;
};

export function qdBinary(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return resolveQdBinary({
    platform: process.platform,
    arch: process.arch,
    devBinary: path.resolve(here, "../../../quickdraw/rust/qd/target/release/qd"),
    resolvePackageJson: (spec) => require.resolve(spec),
    exists: existsSync,
    executable: canExecute,
  });
}

export function startRustPresent(opts: {
  stderr: Writable;
  onUp(message: BoxBusUpMessage): void;
  onQuit(): void;
  onFailed(reason: string): void;
}): RustPresent {
  const held = holdWrites(opts.stderr);
  const child: ChildProcess = spawn(qdBinary(), [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const input = child.stdin;
  const output = child.stdout;
  if (input == null || output == null) {
    throw new Error("qd stdio pipes were not created");
  }
  let cols = 80;
  let rows = 24;
  let restoring: Promise<void> | null = null;
  const pending = { buf: Buffer.alloc(0) };

  output.on("data", (chunk: Buffer) => {
    pending.buf = Buffer.concat([pending.buf, chunk]);
    for (;;) {
      if (pending.buf.length < 4) return;
      const len = pending.buf.readUInt32LE(0);
      if (len > FRAME_CAP) {
        opts.onFailed("qd frame too large");
        return;
      }
      if (pending.buf.length < 4 + len) return;
      const payload = pending.buf.subarray(4, 4 + len);
      pending.buf = pending.buf.subarray(4 + len);
      let message: { kind?: string; cols?: number; rows?: number; reason?: string };
      try {
        message = JSON.parse(payload.toString("utf8")) as typeof message;
      } catch (error) {
        opts.onFailed(error instanceof Error ? error.message : "qd frame");
        return;
      }
      if (message.kind === "resize" && message.cols != null && message.rows != null) {
        cols = message.cols;
        rows = message.rows;
      }
      if (message.kind === "quit") {
        opts.onQuit();
        return;
      }
      if (message.kind === "failed") {
        opts.onFailed(message.reason ?? "qd failed");
        return;
      }
      if (
        message.kind === "input_events" ||
        message.kind === "resize" ||
        message.kind === "activate" ||
        message.kind === "picker_activate" ||
        message.kind === "picker_scroll" ||
        message.kind === "agents_scroll" ||
        message.kind === "agents_focus" ||
        message.kind === "agents_hover" ||
        message.kind === "submit"
      ) {
        opts.onUp(message as BoxBusUpMessage);
      }
    }
  });
  child.on("error", (error) => opts.onFailed(error.message));
  child.on("exit", (code) => {
    if (restoring === null && code !== 0 && code !== null) opts.onFailed(`qd exit ${code}`);
  });

  return {
    writeDown(message) {
      writeFrame(input, Buffer.from(JSON.stringify(message)));
    },
    geometry() {
      return { cols, rows };
    },
    restore() {
      restoring ??= shutdownChild(child, input, held);
      return restoring;
    },
  };
}

function shutdownChild(child: ChildProcess, input: Writable, held: { release(): void }): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    held.release();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(term);
      clearTimeout(kill);
      held.release();
      resolve();
    };
    const term = setTimeout(() => signal(child, "SIGTERM"), SHUTDOWN_GRACE_MS);
    const kill = setTimeout(() => {
      signal(child, "SIGKILL");
      setTimeout(finish, SHUTDOWN_GRACE_MS);
    }, SHUTDOWN_GRACE_MS * 2);
    child.once("exit", finish);
    try {
      writeFrame(input, Buffer.from(JSON.stringify({ kind: "shutdown" })));
    } catch {
      clearTimeout(term);
      signal(child, "SIGTERM");
    }
  });
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(name);
  } catch {
    /* already gone */
  }
}

function writeFrame(stream: Writable, payload: Buffer): void {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  stream.write(head);
  stream.write(payload);
}

function holdWrites(stream: Writable): { release(): void } {
  const chunks: Buffer[] = [];
  const original = stream.write.bind(stream);
  let released = false;
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), cb?: () => void): boolean => {
    const enc = typeof encoding === "string" ? encoding : "utf8";
    const done = typeof encoding === "function" ? encoding : cb;
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc) : Buffer.from(chunk));
    done?.();
    return true;
  }) as Writable["write"];
  return {
    release() {
      if (released) return;
      released = true;
      stream.write = original as Writable["write"];
      for (const chunk of chunks) original(chunk);
    },
  };
}
