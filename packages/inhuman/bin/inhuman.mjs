#!/usr/bin/env node
import { run } from "../dist/bin.js";

const result = await run(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(result.code);
