/**
 * `inhuman start | web | login`: the daemon/door/browser decisions against fakes, the door record file, and routing.
 * The detached process and the real daemon are covered end to end by the packed-install check.
 */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import type { KernelRpc } from "@inhuman.tools/harness-sdk";
import { afterEach, expect, it } from "vitest";

import { ShellContext, type Streams } from "../context.js";
import { isEvalArgv, makeCli } from "../register.js";
import { runRemote } from "../remote-commands.js";
import {
  clearDoorRecord,
  doorRecordPath,
  liveDoor,
  parseDoorRecord,
  writeDoorRecord,
  type DoorRecord,
} from "../web-door.js";
import { ensureServing, runStart, runWeb, StartCommand, WebCommand, type ServeDeps } from "../web-commands.js";

const DOOR: DoorRecord = { pid: 4242, port: 8787, url: "http://127.0.0.1:8787/" };

function fakes(over: { running: boolean; door?: DoorRecord }) {
  const calls: string[] = [];
  const opened: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: ServeDeps = {
    daemonRunning: () => {
      calls.push("probe");
      return Promise.resolve(over.running);
    },
    ensure: () => {
      calls.push("ensure");
      return Promise.resolve();
    },
    findDoor: () => {
      calls.push("findDoor");
      return Promise.resolve(over.door);
    },
    startDoor: (_kernel, port) => {
      calls.push(`startDoor:${port}`);
      return Promise.resolve(DOOR);
    },
    openBrowser: (url) => {
      opened.push(url);
    },
  };
  return {
    deps,
    calls,
    opened,
    out,
    err,
    output: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

it("start: probes before ensure, starts a door, prints the URL and never opens a browser", async () => {
  const f = fakes({ running: false });
  const code = await runStart(f.deps, { kernel: "/k", port: 8787 }, f.output);
  expect(code).toBe(0);
  expect(f.calls).toEqual(["probe", "ensure", "findDoor", "startDoor:8787"]);
  expect(f.out).toEqual([DOOR.url]);
  expect(f.err).toEqual(["daemon: started"]);
  expect(f.opened).toEqual([]);
});

it("start: reuses a live door instead of starting a second one", async () => {
  const f = fakes({ running: true, door: { ...DOOR, port: 9000, url: "http://127.0.0.1:9000/" } });
  await runStart(f.deps, { kernel: "/k", port: 8787 }, f.output);
  expect(f.calls).toEqual(["probe", "ensure", "findDoor"]);
  expect(f.out).toEqual(["http://127.0.0.1:9000/"]);
  expect(f.err).toEqual(["daemon: already running", "web: reusing running door"]);
});

it("web: opens the browser on a fresh daemon", async () => {
  const f = fakes({ running: false });
  await runWeb(f.deps, { kernel: "/k", port: 8787, browser: true }, f.output);
  expect(f.out).toEqual([DOOR.url]);
  expect(f.opened).toEqual([DOOR.url]);
});

it("web: opens the browser even when the daemon was already running", async () => {
  const f = fakes({ running: true });
  await runWeb(f.deps, { kernel: "/k", port: 8787, browser: true }, f.output);
  expect(f.err).toContain("daemon: already running");
  expect(f.opened).toEqual([DOOR.url]);
});

it("web --no-browser prints the URL and never opens one", async () => {
  const f = fakes({ running: false });
  await runWeb(f.deps, { kernel: "/k", port: 8787, browser: false }, f.output);
  expect(f.opened).toEqual([]);
  expect(f.out).toEqual([DOOR.url]);
});

it("propagates an ensure failure and starts no door", async () => {
  const f = fakes({ running: false });
  const deps: ServeDeps = { ...f.deps, ensure: () => Promise.reject(new Error("daemon sock is dead")) };
  await expect(runStart(deps, { kernel: "/k", port: 8787 }, f.output)).rejects.toThrow("sock is dead");
  expect(f.calls).not.toContain("startDoor:8787");
});

it("login brings the daemon and door up before it asks the daemon to log in", async () => {
  const f = fakes({ running: false });
  const order: string[] = [];
  const rpc: KernelRpc = {
    request(method) {
      order.push(method);
      return Promise.resolve({ ok: true, email: "a@b.c", machineId: "m1" });
    },
    [Symbol.asyncDispose]: () => Promise.resolve(),
  } as KernelRpc;
  const sink = new Writable({ write: (_c, _e, cb) => cb() }) as NodeJS.WriteStream;
  const context = new ShellContext({
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as NodeJS.ReadStream,
    stdout: sink,
    stderr: sink,
  });
  const result = await runRemote({ verb: "login", kernel: "/k", browser: false }, context, {
    rpc,
    prepare: async () => {
      await ensureServing(f.deps, { kernel: "/k", port: 8787 }, f.output);
      order.push("serving");
    },
  });
  expect(result.code).toBe(0);
  expect(order).toEqual(["serving", "remote/login"]);
  expect(f.calls).toEqual(["probe", "ensure", "findDoor", "startDoor:8787"]);
  expect(f.opened).toEqual([]);
});

it("parses the door record strictly", () => {
  expect(parseDoorRecord(JSON.stringify(DOOR))).toEqual(DOOR);
  expect(parseDoorRecord("not json")).toBeUndefined();
  expect(parseDoorRecord(JSON.stringify({ pid: "1", port: 1, url: "x" }))).toBeUndefined();
  expect(parseDoorRecord(JSON.stringify({ pid: 0, port: 1, url: "x" }))).toBeUndefined();
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

it("liveDoor needs a live pid and an answering URL; clearDoorRecord only removes its own", async () => {
  dir = await mkdtemp(join(tmpdir(), "ihdoor-"));
  expect(await liveDoor(dir)).toBeUndefined();
  await writeDoorRecord(dir, DOOR);
  const probe = (alive: boolean, answers: boolean) => ({
    alive: () => alive,
    answers: () => Promise.resolve(answers),
  });
  expect(await liveDoor(dir, probe(true, true))).toEqual(DOOR);
  expect(await liveDoor(dir, probe(false, true))).toBeUndefined();
  expect(await liveDoor(dir, probe(true, false))).toBeUndefined();
  await clearDoorRecord(dir, 1);
  expect(await liveDoor(dir, probe(true, true))).toEqual(DOOR);
  await clearDoorRecord(dir, DOOR.pid);
  expect(await liveDoor(dir, probe(true, true))).toBeUndefined();
  await writeFile(doorRecordPath(dir), "{broken");
  expect(await liveDoor(dir, probe(true, true))).toBeUndefined();
});

it("liveDoor asks the real URL: a listening server counts, a closed port does not", async () => {
  dir = await mkdtemp(join(tmpdir(), "ihdoor-"));
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}/`;
  await writeDoorRecord(dir, { pid: process.pid, port, url });
  expect(await liveDoor(dir)).toEqual({ pid: process.pid, port, url });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await liveDoor(dir)).toBeUndefined();
});

it("routes `start` and `web` with their flags and keeps them out of eval routing", () => {
  const streams: Streams = {
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as NodeJS.ReadStream,
    stdout: new Writable({ write: (_c, _e, cb) => cb() }) as NodeJS.WriteStream,
    stderr: new Writable({ write: (_c, _e, cb) => cb() }) as NodeJS.WriteStream,
  };
  const cli = makeCli();
  const context = new ShellContext(streams);
  const start = cli.process(["start", "--kernel", "/k", "--port", "9001"], context);
  expect(start).toBeInstanceOf(StartCommand);
  expect(Reflect.get(start, "port")).toBe("9001");
  const web = cli.process(["web", "--kernel", "/k", "--port", "9001", "--no-browser"], context);
  expect(web).toBeInstanceOf(WebCommand);
  expect(Reflect.get(web, "noBrowser")).toBe(true);
  expect(() => cli.process(["open"], context)).toThrow();
  expect(isEvalArgv(["start", "--mode", "x"])).toBe(false);
  expect(isEvalArgv(["web", "--mode", "x"])).toBe(false);
  expect(isEvalArgv(["web-door", "--kernel", "/k"])).toBe(false);
});
