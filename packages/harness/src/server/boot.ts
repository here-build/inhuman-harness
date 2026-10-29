import { appendFileSync } from "node:fs";

// ensure() spawns this, not bin.js. A stale re-export throws while bin.js is
// still loading, before it opens the log, and the daemon stderr is ignored.
const log = process.env.HARNESS_LOG;
try {
  const { startDaemon } = await import("./bin.js");
  await startDaemon();
} catch (error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const line = `${new Date().toISOString()} daemon pid=${process.pid} FAIL boot ${text.replaceAll(/\s+/g, " ").trim()}\n`;
  if (log !== undefined && log !== "") {
    try {
      appendFileSync(log, line);
    } catch {
      /* the parent still sees the exit code */
    }
  }
  process.exit(1);
}
