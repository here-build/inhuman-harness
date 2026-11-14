import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");

const scopeRequire = createRequire(resolve(REPO_ROOT, "packages/scope-plane/package.json"));
const harnessRequire = createRequire(resolve(REPO_ROOT, "packages/harness/package.json"));

export const Database = scopeRequire("better-sqlite3");
export const mobx = scopeRequire("mobx");
export const wsPkg = harnessRequire("ws");
export const WebSocketServer = wsPkg.WebSocketServer;
export const WebSocket = wsPkg.WebSocket ?? wsPkg.default;

function importDist(relPath) {
  return import(pathToFileURL(resolve(REPO_ROOT, relPath)).href);
}

export const modelPkg = await importDist("packages/model/dist/index.js");
export const sqlitePkg = await importDist("packages/scope-plane/dist/sqlite.js");
export const liveShapePkg = await importDist("packages/scope-plane/dist/live-shape.js");
