/**
 * `harness login | logout | remote status`: routing, the parked open-url form, and the printouts.
 * The daemon is a fake RPC; the real login round trip is the kernel's remote-access test.
 */
import { Readable, Writable } from "node:stream";

import type { KernelRpc } from "@inhuman.tools/harness-sdk";
import { expect, it } from "vitest";

import { ShellContext, type Streams } from "../context.js";
import { isEvalArgv, makeCli } from "../register.js";
import { runRemote } from "../remote-commands.js";
import { exportWebStaticDir } from "../web-static.js";

function capture() {
  let stdout = "";
  let stderr = "";
  const streams: Streams = {
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as NodeJS.ReadStream,
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

function fakeRpc(handler: (method: string, params: unknown) => unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: KernelRpc = {
    request(method, params) {
      calls.push({ method, params });
      return Promise.resolve(handler(method, params));
    },
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  return { rpc, calls };
}

const URL_ = "https://auth.example/device?user_code=ABCD-EFGH";
const PARK = {
  form: "ui",
  pending: "p1",
  body: `(harness/open-url :url "${URL_}" :description "Approve this machine for remote access in the browser, then continue")`,
};

it("routes the remote commands", () => {
  const cli = makeCli();
  const ctx = new ShellContext(capture().streams);
  const name = (argv: string[]) => cli.process(argv, ctx).constructor.name;
  expect([
    name(["login"]),
    name(["login", "--name", "laptop"]),
    name(["logout"]),
    name(["remote"]),
    name(["remote", "status", "--json"]),
  ]).toEqual(["LoginCommand", "LoginCommand", "LogoutCommand", "RemoteCommand", "RemoteStatusCommand"]);
  expect(Reflect.get(cli.process(["login", "--name", "laptop"], ctx), "name")).toBe("laptop");
  expect(isEvalArgv(["login", "--name", "laptop"])).toBe(false);
});

it("login prints the address and code, opens the browser, answers the park, and reports the result", async () => {
  const { rpc, calls } = fakeRpc((method) =>
    method === "remote/login" ? PARK : { ok: true, email: "v@example.com", machineId: "m1" },
  );
  const cap = capture();
  const opened: string[] = [];
  const result = await runRemote({ verb: "login", kernel: "/k", name: "laptop" }, new ShellContext(cap.streams), {
    rpc,
    openBrowser: (url) => opened.push(url),
  });
  expect(result).toEqual({ code: 0 });
  expect(calls).toEqual([
    { method: "remote/login", params: { name: "laptop" } },
    { method: "ui/resolve", params: { pending: "p1", kind: "opened", url: URL_ } },
  ]);
  expect(opened).toEqual([URL_]);
  expect(cap.stderr).toContain(URL_);
  expect(cap.stderr).toContain("ABCD-EFGH");
  expect(cap.stdout).toBe("signed in as v@example.com; machine m1\n");
});

it("login --no-browser only prints, and a cancelled login exits 1", async () => {
  const { rpc, calls } = fakeRpc((method) => (method === "remote/login" ? PARK : { ok: false }));
  const cap = capture();
  const opened: string[] = [];
  const result = await runRemote({ verb: "login", kernel: "/k", browser: false }, new ShellContext(cap.streams), {
    rpc,
    openBrowser: (url) => opened.push(url),
  });
  expect(result).toEqual({ code: 1 });
  expect(opened).toEqual([]);
  expect(calls[0]).toEqual({ method: "remote/login", params: {} });
  expect(cap.stderr).toContain("login cancelled");
});

it("a daemon error is printed and exits 1", async () => {
  const cap = capture();
  const rpc: KernelRpc = {
    request: () => Promise.reject(new Error("Remote access is not configured: set HARNESS_REMOTE_WORKOS_CLIENT_ID")),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  const result = await runRemote({ verb: "login", kernel: "/k" }, new ShellContext(cap.streams), { rpc });
  expect(result).toEqual({ code: 1 });
  expect(cap.stderr).toContain("HARNESS_REMOTE_WORKOS_CLIENT_ID");
});

it("logout reports whether anything was signed in", async () => {
  for (const [wasLoggedIn, line] of [
    [true, "signed out of remote access\n"],
    [false, "was not signed in\n"],
  ] as const) {
    const { rpc, calls } = fakeRpc(() => ({ ok: true, wasLoggedIn }));
    const cap = capture();
    expect(await runRemote({ verb: "logout", kernel: "/k" }, new ShellContext(cap.streams), { rpc })).toEqual({
      code: 0,
    });
    expect(calls).toEqual([{ method: "remote/logout", params: {} }]);
    expect(cap.stdout).toBe(line);
  }
});

it("status prints a table, the last error, and --json verbatim", async () => {
  const status = {
    loggedIn: false,
    machineId: "m1",
    machineName: "box",
    relayUrl: "https://harness.inhuman.tools",
    connected: false,
    lastError: "The remote-access login expired or was revoked. Run `harness login` again.",
  };
  const { rpc } = fakeRpc(() => status);
  const table = capture();
  await runRemote({ verb: "status", kernel: "/k" }, new ShellContext(table.streams), { rpc });
  expect(table.stdout).toContain("signed out");
  expect(table.stdout).toContain("box (m1)");
  expect(table.stdout).toContain("last error");
  expect(table.stdout).toContain("run `harness login` to sign in");

  const json = capture();
  await runRemote({ verb: "status", kernel: "/k", json: true }, new ShellContext(json.streams), { rpc });
  expect(JSON.parse(json.stdout)).toEqual(status);

  const live = fakeRpc(() => ({
    ...status,
    loggedIn: true,
    email: "v@example.com",
    connected: true,
    lastError: undefined,
  }));
  const on = capture();
  await runRemote({ verb: "status", kernel: "/k" }, new ShellContext(on.streams), { rpc: live.rpc });
  expect(on.stdout).toContain("signed in as v@example.com");
  expect(on.stdout).toContain("connected");
});

it("exportWebStaticDir keeps a value that is already set", () => {
  const env: NodeJS.ProcessEnv = { HARNESS_WEB_STATIC_DIR: "/custom" };
  exportWebStaticDir(env);
  expect(env["HARNESS_WEB_STATIC_DIR"]).toBe("/custom");
});
