#!/usr/bin/env node
import { run } from "@inhuman.tools/harness-cli/run";

const OPEN_VALUE_FLAGS = new Set(["--kernel", "--port"]);

/** True for no arguments, or only the flags `harness open` takes: `inhuman --kernel /k --no-browser`. */
function isBareOpen(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-browser" || /^--(?:kernel|port)=/.test(arg)) continue;
    if (OPEN_VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

// `inhuman` opens the web client; any other command line is the harness CLI, verbatim.
const args = process.argv.slice(2);
const result = await run(isBareOpen(args) ? ["open", ...args] : args, {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(result.code);
