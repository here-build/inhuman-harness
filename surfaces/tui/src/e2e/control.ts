/**
 * TCP JSON-line control channel between the vitest host and a scenario
 * process running inside a real terminal.
 *
 * Scenario → host:  { "type": "ready" } | { "type": "error", "message": "…" }
 * Host → scenario:  { "type": "step", "name": "…" } | { "type": "quit" }
 *
 * Ready is credit-based (not a sticky flag): each `{type:"ready"}` increments
 * a counter; each `waitReady()` consumes one credit. That way:
 *  - ready-before-waitReady does not hang (race fixed)
 *  - step N cannot spuriously complete on ready from step N-1
 */

import { createServer, type Server, type Socket } from "node:net";

import invariant from "tiny-invariant";

export type ControlInbound = { type: "ready" } | { type: "error"; message: string } | { type: "log"; message: string };

export type ControlOutbound = { type: "step"; name: string } | { type: "quit" };

export type ControlHost = {
  readonly port: number;
  readonly host: string;
  /** Wait for one ready credit from the scenario (timeout rejects). */
  waitReady(timeoutMs?: number): Promise<void>;
  send(msg: ControlOutbound): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

function parseLines(buf: string, onMsg: (m: ControlInbound) => void): string {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  for (const line of parts) {
    const t = line.trim();
    if (!t) continue;
    try {
      onMsg(JSON.parse(t) as ControlInbound);
    } catch {
      // ignore non-JSON
    }
  }
  return rest;
}

export async function createControlHost(host = "127.0.0.1"): Promise<ControlHost> {
  let socket: Socket | null = null;
  let carry = "";
  /** Unconsumed ready events (scenario can ready before waitReady is registered). */
  let readyCredits = 0;
  const readyWaiters: Array<() => void> = [];
  const errorWaiters: Array<(e: Error) => void> = [];

  const signalReady = () => {
    if (readyWaiters.length > 0) {
      readyWaiters.shift()!();
    } else {
      readyCredits += 1;
    }
  };

  const signalError = (err: Error) => {
    while (errorWaiters.length > 0) errorWaiters.shift()!(err);
    while (readyWaiters.length > 0) {
      const w = readyWaiters.shift();
      void w;
    }
  };

  const server: Server = createServer((s) => {
    // Last connection wins (one scenario per host).
    if (socket && socket !== s) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    socket = s;
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      carry = parseLines(carry + chunk, (m) => {
        if (m.type === "ready") {
          signalReady();
        } else if (m.type === "error") {
          signalError(new Error(m.message));
        }
      });
    });
    s.on("close", () => {
      if (socket === s) socket = null;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const addr = server.address();
  invariant(addr != null, "control host failed to bind TCP port");
  invariant(typeof addr !== "string", "control host bound a non-TCP address");

  return {
    host,
    port: addr.port,
    waitReady(timeoutMs = 30_000) {
      return new Promise<void>((resolve, reject) => {
        if (readyCredits > 0) {
          readyCredits -= 1;
          resolve();
          return;
        }

        const t = setTimeout(() => {
          // remove this waiter if still queued
          const i = readyWaiters.indexOf(onReady);
          if (i !== -1) readyWaiters.splice(i, 1);
          const j = errorWaiters.indexOf(onErr);
          if (j !== -1) errorWaiters.splice(j, 1);
          reject(new Error(`scenario ready timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const onReady = () => {
          clearTimeout(t);
          const j = errorWaiters.indexOf(onErr);
          if (j !== -1) errorWaiters.splice(j, 1);
          resolve();
        };
        const onErr = (e: Error) => {
          clearTimeout(t);
          const i = readyWaiters.indexOf(onReady);
          if (i !== -1) readyWaiters.splice(i, 1);
          reject(e);
        };

        readyWaiters.push(onReady);
        errorWaiters.push(onErr);
      });
    },
    async send(msg) {
      invariant(socket != null, "scenario control socket not connected");
      invariant(!socket.destroyed, "scenario control socket was destroyed");
      await new Promise<void>((resolve, reject) => {
        socket!.write(`${JSON.stringify(msg)}\n`, (err) => (err ? reject(err) : resolve()));
      });
    },
    async [Symbol.asyncDispose]() {
      try {
        if (socket && !socket.destroyed) {
          socket.write(`${JSON.stringify({ type: "quit" })}\n`);
          socket.end();
        }
      } catch {
        /* ignore */
      }
      socket = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
