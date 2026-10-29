import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.env.HARNESS_PID_FILE;
if (pidFile === undefined || pidFile === "") {
  throw new Error("HARNESS_PID_FILE is required");
}

const child = spawn(process.execPath, process.argv.slice(2), {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
if (child.pid === undefined) throw new Error("no child pid");
child.unref();
writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1 << 30);
