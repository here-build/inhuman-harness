/**
 * RESOLVE_BEFORE_MINT: unknown/ambiguous `--model` / `--connection` must
 * not create a session.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { HarnessDaemon, listenCompat, sequenceReply } from "@inhuman.tools/harness/testkit";
import { Client } from "@inhuman.tools/harness-sdk";
import { applyResolvedAgent, type Streams } from "@inhuman.tools/harness-sdk/launch";
import { expect, it, onTestFinished } from "vitest";

import { run } from "../../bin.js";

const TIMEOUT = 30_000;

function capture(cwd = ""): {
  readonly streams: Streams;
  readonly stdout: string;
  readonly stderr: string;
} {
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
    cwd,
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

it(
  "resolves --model against live catalogs, stamps session kv, and restore switches",
  async () => {
    const kernel = await mkdtemp(join(tmpdir(), "harness-model-flags-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-model-flags-p-"));
    onTestFinished(async () => {
      await rm(kernel, { recursive: true, force: true, maxRetries: 10 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 10 });
    });
    await writeFile(join(kernel, "config.json"), JSON.stringify({ connections: {} }));
    const daemon = new HarnessDaemon(kernel);
    await daemon.listen();
    onTestFinished(async () => {
      await daemon[Symbol.asyncDispose]();
    });
    const alpha = await listenCompat({ models: [{ id: "alpha-1" }, { id: "shared" }], reply: sequenceReply });
    const beta = await listenCompat({ models: [{ id: "beta-1" }, { id: "shared" }], reply: sequenceReply });
    onTestFinished(async () => {
      await alpha.close();
      await beta.close();
    });
    {
      await using adopt = await Client.kernel(kernel);
      await adopt.request("connect/adopt", {
        driver: "openai-compat",
        name: "Alpha",
        settings: { baseUrl: alpha.baseUrl },
      });
      await adopt.request("connect/adopt", {
        driver: "openai-compat",
        name: "Beta",
        settings: { baseUrl: beta.baseUrl },
      });
    }

    const unknown = capture(workspace);
    const unknownRun = await run(["-e", "(+ 1 2)", "--connection", "nope", "--kernel", kernel], unknown.streams);
    const kernelSessions = Object.keys((await daemon.kernel()).plexus.root.sessions);

    const ambiguous = capture(workspace);
    const ambiguousRun = await run(["-e", "(+ 1 2)", "--model", "shared", "--kernel", kernel], ambiguous.streams);

    const unique = capture(workspace);
    const uniqueRun = await run(["-e", "(+ 1 2)", "--model", "alpha-1", "--kernel", kernel], unique.streams);
    const sessionId = /connect later with --resume (\S+)/.exec(unique.stderr)?.[1];
    await using minted = await Client.connect(kernel, workspace, sessionId!);
    const mintedKv = { ...minted.sessionRoot.kvs };
    const mintedLast = { ...minted.sessionRoot.lastUsedConnectionModel };

    await applyResolvedAgent((method, params) => minted.request(method, params), {
      connection: "beta",
      model: "beta-1",
    });
    const switched = { ...minted.sessionRoot.kvs };
    const switchedLast = { ...minted.sessionRoot.lastUsedConnectionModel };

    expect({
      unknown: { code: unknownRun.code, stderr: unknown.stderr, sessions: kernelSessions },
      ambiguous: { code: ambiguousRun.code, stderr: ambiguous.stderr },
      unique: {
        code: uniqueRun.code,
        stdout: unique.stdout,
        kv: { connection: mintedKv.connection, model: mintedKv.model, last: mintedLast.alpha },
      },
      switched: {
        connection: switched.connection,
        model: switched.model,
        last: switchedLast.beta,
      },
    }).toEqual({
      unknown: {
        code: 1,
        stderr: expect.stringMatching(/unknown connection "nope"/),
        sessions: [],
      },
      ambiguous: {
        code: 1,
        stderr: expect.stringMatching(/multiple connections: alpha, beta/),
      },
      unique: {
        code: 0,
        stdout: "3\n",
        kv: { connection: "alpha", model: "alpha-1", last: undefined },
      },
      switched: { connection: "beta", model: "beta-1", last: undefined },
    });
  },
  TIMEOUT,
);
