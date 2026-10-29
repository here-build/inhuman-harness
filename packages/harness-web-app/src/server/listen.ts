/**
 * Loopback origin. Replays room upgrades onto the daemon unix socket.
 * Does not speak Yjs and does not open rooms.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- static files are the request path, kept inside staticDir */
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { extname, isAbsolute, join, normalize, relative as pathRelative, resolve as pathResolve, sep } from "node:path";
import type { Duplex } from "node:stream";

const ROOMS = new Set(["/kernel", "/project", "/session"]);

export type ListenWebAppOptions = {
  readonly sockPath: string;
  readonly port: number;
  /** Page serving. Tests leave this off. */
  readonly pages?: "none" | "vite" | "static";
  readonly staticDir?: string;
  readonly viteRoot?: string;
  /** Project roots the /file route may read. Empty refuses every file request. */
  readonly fileRoots?: readonly string[];
  /**
   * Extra browser origins allowed to open a room, beside the server's own loopback origins.
   * A request with no Origin header (a native client) is always allowed.
   */
  readonly extraOrigins?: readonly string[];
};

export type WebAppServer = {
  readonly port: number;
  close(): Promise<void>;
};

export async function listenWebApp(options: ListenWebAppOptions): Promise<WebAppServer> {
  const pages = options.pages ?? "none";
  const handle = await pageHandler(pages, options);
  const server = createServer((request, response) => {
    if (request.method === "GET" || request.method === "HEAD") {
      const pathname = (request.url ?? "/").split("?")[0] ?? "/";
      if (pathname === "/file") {
        void sendProjectFile(options.fileRoots ?? [], request, response);
        return;
      }
      handle(request, response);
      return;
    }
    response.writeHead(405, { "content-type": "text/plain" });
    response.end("method not allowed");
  });

  const allowed = new Set<string>((options.extraOrigins ?? []).map(normalizeOrigin));
  server.on("upgrade", (request, socket, head) => {
    if (!originAllowed(request.headers.origin, allowed)) {
      refuse(socket, 403, "forbidden origin");
      return;
    }
    replayUpgrade(options.sockPath, request, socket, head);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("web-app listen did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  allowed.add(`http://127.0.0.1:${port}`);
  allowed.add(`http://localhost:${port}`);

  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Browsers do not apply the same-origin policy to WebSockets, so a page on any site could reach the
 * daemon through this proxy. A native client sends no Origin; a browser always does. The literal
 * `null` (sandboxed frames, file pages) is never allowed.
 */
export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  return allowed.has(normalizeOrigin(origin));
}

function replayUpgrade(sockPath: string, request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const pathname = (request.url ?? "/").split("?")[0] ?? "/";
  if (!ROOMS.has(pathname)) {
    refuse(socket, 404, "not found");
    return;
  }
  const upstream = connect(sockPath);
  const fail = (): void => {
    if (!socket.destroyed) refuse(socket, 502, "bad gateway");
    upstream.destroy();
  };
  upstream.on("error", fail);
  socket.on("error", () => upstream.destroy());
  upstream.once("connect", () => {
    const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      lines.push(`${request.rawHeaders[i] ?? ""}: ${request.rawHeaders[i + 1] ?? ""}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

type PageHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function pageHandler(pages: "none" | "vite" | "static", options: ListenWebAppOptions): Promise<PageHandler> {
  if (pages === "vite" && options.viteRoot != null) {
    try {
      const viteModule = await import("vite");
      const vite = await viteModule.createServer({
        root: options.viteRoot,
        server: { middlewareMode: true },
        appType: "spa",
        plugins: [
          {
            name: "harness-project-file",
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                const pathname = (request.url ?? "/").split("?")[0] ?? "/";
                if (pathname !== "/file") {
                  next();
                  return;
                }
                void sendProjectFile(options.fileRoots ?? [], request, response);
              });
            },
          },
        ],
      });
      return (request, response) => {
        vite.middlewares(request, response, () => {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
        });
      };
    } catch {
      /* static or stub */
    }
  }
  const dir = options.staticDir;
  if ((pages === "static" || pages === "vite") && dir != null && existsSync(dir)) {
    return (request, response) => {
      void sendStatic(dir, request, response);
    };
  }
  if (pages === "none") {
    return (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    };
  }
  return (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("inhuman\n");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function sendStatic(dir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^\/+/, "");
  const file = join(dir, relative);
  if (!file.startsWith(dir)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    if (url.pathname !== "/" && url.pathname !== "/file" && statOrNull(join(dir, "index.html"))) {
      const body = await readFile(join(dir, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }
}

const FILE_TYPES: Record<string, string> = {
  ...TYPES,
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function sendProjectFile(
  roots: readonly string[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const asked = url.searchParams.get("path") ?? "";
  const file = fileInsideRoots(roots, asked);
  if (file == null) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    const type = FILE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type, "x-harness-file": "1" });
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }
}

/** Lexical containment, then realpath. A symlink that leaves the root is refused. */
export function fileInsideRoots(roots: readonly string[], asked: string): string | null {
  if (asked.trim() === "" || !isAbsolute(asked)) return null;
  const candidate = normalize(asked);
  for (const root of roots) {
    if (!inside(root, candidate)) continue;
    try {
      const realRoot = realpathSync(root);
      const realFile = realpathSync(candidate);
      if (!inside(realRoot, realFile) || !statSync(realFile).isFile()) return null;
      return realFile;
    } catch {
      return null;
    }
  }
  return null;
}

function inside(root: string, file: string): boolean {
  const from = pathRelative(pathResolve(root), pathResolve(file));
  return from !== "" && !from.startsWith(`..${sep}`) && from !== ".." && !isAbsolute(from);
}

function statOrNull(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
