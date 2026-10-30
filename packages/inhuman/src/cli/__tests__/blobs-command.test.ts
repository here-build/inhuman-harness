/**
 * `inhuman blobs vacuum --session <id> [--kernel <path>] [--dry-run]`: routing, usage failures, and the printout.
 * The daemon is a fake that answers `blob/vacuum`; the real round trip is the vacuum RPC test in the core.
 */
import { Readable, Writable } from "node:stream";

import { RestoreNotFound } from "@inhuman.tools/harness-sdk";
import { expect, it } from "vitest";

import { run } from "../../bin.js";
import { runBlobsVacuum, type SessionRpc } from "../blobs-command.js";
import { ShellContext, type Streams } from "../context.js";
import { isEvalArgv, makeCli } from "../register.js";

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

/** A restored session that answers `blob/vacuum` with a canned reply and remembers what was asked. */
function fakeSession(reply: unknown) {
  const asked: Array<{ method: string; params: unknown }> = [];
  let disposed = 0;
  const rpc: SessionRpc = {
    request: (method, params) => {
      asked.push({ method, params });
      return Promise.resolve(reply);
    },
    [Symbol.asyncDispose]: () => {
      disposed += 1;
      return Promise.resolve();
    },
  };
  return {
    asked,
    get disposed() {
      return disposed;
    },
    open: async (kernel: string, session: string, phase: (label: string) => void) => {
      phase("syncing the session...");
      asked.push({ method: "open", params: { kernel, session } });
      return rpc;
    },
  };
}

const MOVED = {
  dryRun: false,
  fileMutates: 12,
  promptMessages: 46,
  promptTexts: 23,
  bytesMoved: 11_502_183,
  imageBytesBefore: 15_933_834,
  imageBytesAfter: 412_660,
};

it("routes blobs vacuum with its flags", () => {
  const cli = makeCli();
  const ctx = new ShellContext(capture().streams);
  const routes = [
    { argv: ["blobs", "vacuum", "--session", "s1"], className: "BlobsVacuumCommand", session: "s1", dryRun: false },
    {
      argv: ["blobs", "vacuum", "--session", "s1", "--dry-run", "--kernel", "other"],
      className: "BlobsVacuumCommand",
      session: "s1",
      dryRun: true,
      kernel: "other",
    },
    { argv: ["blobs"], className: "BlobsCommand" },
  ];
  expect(
    routes.map((row) => {
      const cmd = cli.process(row.argv, ctx);
      return Object.fromEntries(
        Object.entries(row).map(([key, want]) => [
          key,
          key === "argv" ? want : key === "className" ? cmd.constructor.name : Reflect.get(cmd, key),
        ]),
      );
    }),
  ).toEqual(routes);
  // A bare `blobs` or a session flag value is never mistaken for an eval program.
  expect([isEvalArgv(["blobs", "vacuum", "--session", "s1"]), isEvalArgv(["blobs"])]).toEqual([false, false]);
});

it("usage failures exit 2 on stderr", async () => {
  const rows = [
    { argv: ["blobs"], match: /Specify a blobs command/ },
    { argv: ["blobs", "vacuum"], match: /--session|Missing|required/i },
    { argv: ["blobs", "vacuum", "--session", "s1", "--model", "grok-4"], match: /does not select a model/ },
    { argv: ["blobs", "gc"], match: /gc|Command not found/i },
  ];
  const observed = [];
  for (const row of rows) {
    const cap = capture();
    const result = await run(row.argv, cap.streams);
    observed.push({ argv: row.argv, code: result.code, stderr: cap.stderr });
  }
  expect(observed).toEqual(rows.map((row) => ({ argv: row.argv, code: 2, stderr: expect.stringMatching(row.match) })));
});

it("asks the daemon to vacuum the session and prints the counts and the image either side", async () => {
  const cap = capture();
  const daemon = fakeSession(MOVED);
  const result = await runBlobsVacuum({ kernel: "/k", session: "s1", dryRun: false }, new ShellContext(cap.streams), {
    open: daemon.open,
  });
  expect({ result, asked: daemon.asked, disposed: daemon.disposed, stderr: cap.stderr, stdout: cap.stdout }).toEqual({
    result: { code: 0 },
    asked: [
      { method: "open", params: { kernel: "/k", session: "s1" } },
      { method: "blob/vacuum", params: { dryRun: false } },
    ],
    disposed: 1,
    stderr: "syncing the session...\n",
    stdout: [
      "vacuum s1",
      "  file prior texts  12",
      "  prompt messages   46",
      "  prompt lines      23",
      "  moved             11.5 MB (11,502,183 bytes)",
      "  stored image      15.9 MB -> 0.4 MB (15,933,834 -> 412,660 bytes)",
      "",
    ].join("\n"),
  });
});

it("a dry run asks for one and prints that nothing was written", async () => {
  const cap = capture();
  const daemon = fakeSession({ ...MOVED, dryRun: true, imageBytesAfter: MOVED.imageBytesBefore });
  const result = await runBlobsVacuum({ kernel: "/k", session: "s1", dryRun: true }, new ShellContext(cap.streams), {
    open: daemon.open,
  });
  expect({ result, asked: daemon.asked.at(-1), stdout: cap.stdout }).toEqual({
    result: { code: 0 },
    asked: { method: "blob/vacuum", params: { dryRun: true } },
    stdout: [
      "dry run: vacuum s1",
      "  file prior texts  12",
      "  prompt messages   46",
      "  prompt lines      23",
      "  would move        11.5 MB (11,502,183 bytes)",
      "  stored image      15.9 MB (15,933,834 bytes), unchanged",
      "",
    ].join("\n"),
  });
});

it("names a session the daemon does not have", async () => {
  const cap = capture();
  const result = await runBlobsVacuum(
    { kernel: "/k", session: "ghost", dryRun: false },
    new ShellContext(cap.streams),
    {
      open: () => Promise.reject(new RestoreNotFound("ghost")),
    },
  );
  expect({ result, stdout: cap.stdout, stderr: cap.stderr }).toEqual({
    result: { code: 1 },
    stdout: "",
    stderr: "session not found: ghost\n",
  });
});

it("reports a daemon error and still lets go of the session", async () => {
  const cap = capture();
  let disposed = 0;
  const result = await runBlobsVacuum({ kernel: "/k", session: "s1", dryRun: false }, new ShellContext(cap.streams), {
    open: () =>
      Promise.resolve({
        request: () => Promise.reject(new Error("ENOSPC: the bucket refused a put")),
        [Symbol.asyncDispose]: () => {
          disposed += 1;
          return Promise.resolve();
        },
      }),
  });
  expect({ result, disposed, stderr: cap.stderr }).toEqual({
    result: { code: 1 },
    disposed: 1,
    stderr: "ENOSPC: the bucket refused a put\n",
  });
});

it("refuses a reply it cannot read instead of printing zeros", async () => {
  const cap = capture();
  const result = await runBlobsVacuum({ kernel: "/k", session: "s1", dryRun: false }, new ShellContext(cap.streams), {
    open: fakeSession({ dryRun: false, fileMutates: 1 }).open,
  });
  expect({ result, stdout: cap.stdout, stderr: cap.stderr }).toEqual({
    result: { code: 1 },
    stdout: "",
    stderr: "syncing the session...\nblob/vacuum: promptMessages is missing\n",
  });
});
