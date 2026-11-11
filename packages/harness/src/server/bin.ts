#!/usr/bin/env node
import { lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { installProcessLog, note } from "@inhuman.tools/harness-diagnostics";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";

import { runSupervisedProcess } from "@/hypervisor/child-runtime";

import { HarnessDaemon } from "./daemon/server/HarnessDaemon.js";
import { openLog } from "./step.js";

const SOCKET_CHECK_MS = 5000;

function socketIno(path: string): number | undefined {
  try {
    return lstatSync(path).ino;
  } catch {
    return undefined;
  }
}

export async function startDaemon(): Promise<void> {
  const log = openLog(process.cwd());
  installProcessLog("daemon");
  note(`log ${log} pid=${process.pid}`);
  note(`daemon listen ${process.cwd()}`);
  const daemon = new HarnessDaemon(process.cwd());
  await daemon.listen();
  const sock = daemonSocketPath(realpathSync(process.cwd()));
  const bound = socketIno(sock);
  note(`daemon ready ${sock}`);
  let shuttingDown = false;
  const shutdownDaemon = (why: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(socketCheck);
    note(`daemon ${why} shutdown`);
    void (async () => {
      await daemon[Symbol.asyncDispose]();
      process.exit(0);
    })();
  };
  // Clients find the daemon only through this path. Unlinked (kernel removed)
  // or rebound by another daemon, this process is unreachable and would live forever.
  const socketCheck = setInterval(() => {
    if (socketIno(sock) !== bound) shutdownDaemon("socket lost");
  }, SOCKET_CHECK_MS);
  socketCheck.unref();
  process.on("SIGINT", () => shutdownDaemon("signal"));
  process.on("SIGTERM", () => shutdownDaemon("signal"));
}

export async function startSupervisedDaemon(argv = process.argv.slice(2)): Promise<number> {
  const log = openLog(process.cwd());
  installProcessLog("daemon");
  note(`log ${log} pid=${process.pid} supervised=true`);
  return runSupervisedProcess({
    argv,
    start: async () => {
      const daemon = new HarnessDaemon(process.cwd());
      await daemon.listen();
      return async () => {
        await daemon[Symbol.asyncDispose]();
        return "ok" as const;
      };
    },
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--supervised")) {
    const code = await startSupervisedDaemon();
    if (code !== 0) process.exit(code);
  } else {
    await startDaemon();
  }
}
