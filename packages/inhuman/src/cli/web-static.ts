import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read by the daemon (`kernel/remote-http.ts`): where the web app's built client lives. */
export const WEB_STATIC_DIR_ENV = "HARNESS_WEB_STATIC_DIR";

/**
 * The daemon does not depend on the web app, so a daemon this CLI spawns learns the built client's
 * directory through its environment. A daemon that is already running keeps what it was started with.
 */
export function exportWebStaticDir(env: NodeJS.ProcessEnv = process.env): void {
  if ((env[WEB_STATIC_DIR_ENV] ?? "").trim() !== "") return;
  try {
    const root = dirname(fileURLToPath(import.meta.resolve("@inhuman.tools/harness-web-app/package.json")));
    const dir = join(root, "dist/client");
    if (existsSync(join(dir, "index.html"))) env[WEB_STATIC_DIR_ENV] = dir;
  } catch {
    // The web app is not installed; /app/* will answer 404 with a reason.
  }
}
