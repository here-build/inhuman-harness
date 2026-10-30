/**
 * `inhuman open`: the daemon/door/browser decisions against fakes, the door record file, and routing.
 * The detached process and the real daemon are covered end to end by the packed-install check.
 */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, expect, it } from "vitest";

import { ShellContext, type Streams } from "../context.js";
import { OpenCommand, runOpen, type OpenDeps } from "../open-command.js";
import { isEvalArgv, makeCli } from "../register.js";
import {
  clearDoorRecord,
  doorRecordPath,
  liveDoor,
  parseDoorRecord,
  writeDoorRecord,
  type DoorRecord,
} from "../web-door.js";

const DOOR: DoorRecord = { pid: 4242, port: 8787, url: "http://127.0.0.1:8787/" };

function fakes(over: { running: boolean; door?: DoorRecord }) {
  const calls: string[] = [];
  const opened: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: OpenDeps = {
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

it("probes before ensure, starts a door, opens the browser on a fresh daemon", async () => {
  const f = fakes({ running: false });
  const code = await runOpen(f.deps, { kernel: "/k", port: 8787, browser: true }, f.output);
  expect(code).toBe(0);
  expect(f.calls).toEqual(["probe", "ensure", "findDoor", "startDoor:8787"]);
  expect(f.out).toEqual([DOOR.url]);
  expect(f.err).toEqual(["daemon: started"]);
  expect(f.opened).toEqual([DOOR.url]);
});

it("does not open a browser when the daemon was already running", async () => {
  const f = fakes({ running: true });
  await runOpen(f.deps, { kernel: "/k", port: 8787, browser: true }, f.output);
  expect(f.opened).toEqual([]);
  expect(f.err).toContain("daemon: already running");
  expect(f.out).toEqual([DOOR.url]);
});

it("reuses a live door instead of starting a second one", async () => {
  const f = fakes({ running: true, door: { ...DOOR, port: 9000, url: "http://127.0.0.1:9000/" } });
  await runOpen(f.deps, { kernel: "/k", port: 8787, browser: true }, f.output);
  expect(f.calls).toEqual(["probe", "ensure", "findDoor"]);
  expect(f.out).toEqual(["http://127.0.0.1:9000/"]);
});

it("--no-browser prints the URL and never opens one", async () => {
  const f = fakes({ running: false });
  await runOpen(f.deps, { kernel: "/k", port: 8787, browser: false }, f.output);
  expect(f.opened).toEqual([]);
  expect(f.out).toEqual([DOOR.url]);
});

it("propagates an ensure failure and starts no door", async () => {
  const f = fakes({ running: false });
  const deps: OpenDeps = { ...f.deps, ensure: () => Promise.reject(new Error("daemon sock is dead")) };
  await expect(runOpen(deps, { kernel: "/k", port: 8787, browser: true }, f.output)).rejects.toThrow("sock is dead");
  expect(f.calls).not.toContain("startDoor:8787");
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

it("routes `open` with its flags and keeps it out of eval routing", () => {
  const streams: Streams = {
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as NodeJS.ReadStream,
    stdout: new Writable({ write: (_c, _e, cb) => cb() }) as NodeJS.WriteStream,
    stderr: new Writable({ write: (_c, _e, cb) => cb() }) as NodeJS.WriteStream,
  };
  const cli = makeCli();
  const command = cli.process(["open", "--kernel", "/k", "--port", "9001", "--no-browser"], new ShellContext(streams));
  expect(command).toBeInstanceOf(OpenCommand);
  expect(Reflect.get(command, "port")).toBe("9001");
  expect(Reflect.get(command, "noBrowser")).toBe(true);
  expect(isEvalArgv(["open", "--mode", "x"])).toBe(false);
  expect(isEvalArgv(["web-door", "--kernel", "/k"])).toBe(false);
});
