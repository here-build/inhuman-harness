/**
 * CLI --no-browser paste and the browser open answer the same park door.
 */
import { Readable, Writable } from "node:stream";

import type { KernelRpc } from "@inhuman.tools/harness-sdk";
import { expect, it } from "vitest";

import { ShellContext, type Streams } from "../context.js";
import { runMcp, type McpArgv } from "../mcp.js";

function capture(tty = false) {
  let stdout = "";
  let stderr = "";
  const streams: Streams = {
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: tty }) as NodeJS.ReadStream,
    stdout: new Writable({
      write(chunk, _enc, cb) {
        stdout += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
    stderr: new Writable({
      write(chunk, _enc, cb) {
        stderr += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
  };
  return {
    streams,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function fakeRpc(handler: (method: string, params: unknown) => unknown | Promise<unknown>): {
  rpc: KernelRpc;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        return await handler(method, params);
      },
      async [Symbol.asyncDispose]() {},
    },
  };
}

function base(over: Partial<McpArgv> & Pick<McpArgv, "mcpVerb">): McpArgv {
  return { kernel: "/tmp/harness-mcp", ...over };
}

it("mcp login CLI: opens the URL, or hands back the paste; the daemon holds the loopback", async () => {
  const loginPark = {
    form: "ui",
    pending: "p1",
    body: `(harness/open-url :url "https://auth.example/authorize?x=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback" :input 'password)`,
  };
  const authorize = "https://auth.example/authorize?x=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback";
  const paste = fakeRpc(async (method) => (method === "connect/login" ? loginPark : { ok: true }));
  const pasteCap = capture(true);
  const pasteResult = await runMcp(
    base({ mcpVerb: "login", name: "sentry", noBrowser: true }),
    new ShellContext(pasteCap.streams),
    {
      rpc: paste.rpc,
      readLine: async () => "http://127.0.0.1:9/callback?code=abc&state=st",
    },
  );
  const browser = fakeRpc(async (method) => (method === "connect/login" ? loginPark : { ok: true }));
  const opened: string[] = [];
  const browserResult = await runMcp(
    base({ mcpVerb: "login", name: "sentry" }),
    new ShellContext(capture(true).streams),
    {
      rpc: browser.rpc,
      openBrowser: (url) => {
        opened.push(url);
      },
    },
  );
  expect({
    paste: {
      code: pasteResult.code,
      calls: paste.calls,
      printedAuthorize: pasteCap.stderr.includes(authorize),
    },
    browser: { code: browserResult.code, opened, calls: browser.calls },
  }).toEqual({
    paste: {
      code: 0,
      printedAuthorize: true,
      calls: [
        { method: "connect/login", params: { id: "sentry" } },
        {
          method: "ui/resolve",
          params: { pending: "p1", kind: "text", input: "http://127.0.0.1:9/callback?code=abc&state=st" },
        },
      ],
    },
    browser: {
      code: 0,
      opened: [authorize],
      calls: [
        { method: "connect/login", params: { id: "sentry" } },
        { method: "ui/resolve", params: { pending: "p1", kind: "opened", url: authorize } },
      ],
    },
  });
});
