/**
 * Local HTTP for tunnelled `req` frames: the web app's static bundle under
 * `/app/*` and project files at `/file?path=`. Same rules as the loopback
 * server in `harness-web-app/src/server/listen.ts`, which cannot be shared:
 * that package ships dependency-free, so this is a small copy shaped for
 * streaming (a body iterable and an abort signal, not a ServerResponse).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- paths are request input, confined to staticDir / fileRoots */
import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** Set by the CLI when it spawns the daemon: the web app's built client directory. */
export const WEB_STATIC_DIR_ENV = "HARNESS_WEB_STATIC_DIR";

export type LocalHttp = {
  /** Built web app (`dist/client`). Unset answers `/app/*` with 404 and a reason. */
  readonly staticDir?: string | undefined;
  /** Project roots `/file` may read. Evaluated per request. */
  readonly fileRoots: () => readonly string[];
};

export type LocalResponse = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Array<[string, string]>;
  /** Absent for HEAD and empty answers. */
  readonly body?: AsyncIterable<Uint8Array>;
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const FILE_TYPES: Record<string, string> = {
  ...TYPES,
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
};

const CHUNK = 256 * 1024;

function text(status: number, message: string): LocalResponse {
  const body = Buffer.from(message);
  return {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: [
      ["content-type", "text/plain; charset=utf-8"],
      ["content-length", String(body.length)],
    ],
    body: (async function* () {
      yield body;
    })(),
  };
}

export function serveLocal(http: LocalHttp, method: string, url: string, signal?: AbortSignal): Promise<LocalResponse> {
  if (method !== "GET" && method !== "HEAD") return Promise.resolve(text(405, "method not allowed"));
  let parsed: URL;
  try {
    parsed = new URL(url, "http://local.invalid");
  } catch {
    return Promise.resolve(text(400, "bad url"));
  }
  const head = method === "HEAD";
  const { pathname } = parsed;
  if (pathname === "/file") return Promise.resolve(projectFile(http.fileRoots(), parsed, head, signal));
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return Promise.resolve(staticFile(http.staticDir, pathname.slice("/app".length), head, signal));
  }
  return Promise.resolve(text(404, "not found"));
}

function staticFile(dir: string | undefined, rest: string, head: boolean, signal?: AbortSignal): LocalResponse {
  if (dir === undefined || dir === "") {
    return text(404, "the web app is not available: the daemon was started without a static directory");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return text(400, "bad path");
  }
  const root = resolve(dir);
  const wanted = decoded === "" || decoded === "/" ? "index.html" : normalize(decoded).replace(/^[/\\]+/, "");
  let file = resolve(root, wanted);
  if (!contained(root, file)) return text(404, "not found");
  if (!isFile(file)) {
    // SPA fallback for client routes; a missing asset (has an extension) stays 404.
    if (extname(wanted) !== "") return text(404, "not found");
    file = join(root, "index.html");
    if (!isFile(file)) return text(404, "the web app is not built: index.html is missing");
  }
  const hashed = /(^|[/\\])assets[/\\]/.test(relative(root, file));
  return sendFile(file, TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", head, signal, [
    ["cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache"],
  ]);
}

function projectFile(roots: readonly string[], url: URL, head: boolean, signal?: AbortSignal): LocalResponse {
  const file = fileInsideRoots(roots, url.searchParams.get("path") ?? "");
  if (file === null) return text(404, "not found");
  return sendFile(file, FILE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", head, signal, [
    ["x-harness-file", "1"],
  ]);
}

function sendFile(
  file: string,
  type: string,
  head: boolean,
  signal: AbortSignal | undefined,
  extra: Array<[string, string]>,
): LocalResponse {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return text(404, "not found");
  }
  const headers: Array<[string, string]> = [["content-type", type], ["content-length", String(size)], ...extra];
  if (head) return { status: 200, statusText: "OK", headers };
  const stream = createReadStream(file, { highWaterMark: CHUNK, ...(signal === undefined ? {} : { signal }) });
  return { status: 200, statusText: "OK", headers, body: stream };
}

/** Lexical containment, then realpath. A symlink that leaves the root is refused. */
export function fileInsideRoots(roots: readonly string[], asked: string): string | null {
  if (asked.trim() === "" || !isAbsolute(asked)) return null;
  const candidate = normalize(asked);
  for (const root of roots) {
    if (!contained(root, candidate)) continue;
    try {
      const realRoot = realpathSync(root);
      const realFile = realpathSync(candidate);
      if (!contained(realRoot, realFile) || !statSync(realFile).isFile()) return null;
      return realFile;
    } catch {
      return null;
    }
  }
  return null;
}

function contained(root: string, file: string): boolean {
  const from = relative(resolve(root), resolve(file));
  return from !== "" && from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from);
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
