#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { Streams } from "./cli/context.js";
import { runCli } from "./cli/register.js";

export async function run(argv: readonly string[], streams: Streams): Promise<{ readonly code: number }> {
  return { code: await runCli(argv, streams) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const result = await run(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(result.code);
}
