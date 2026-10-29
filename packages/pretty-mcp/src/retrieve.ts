/* eslint-disable security/detect-non-literal-fs-filename -- retrieve reads/writes caller paths */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseChromeToolReference, parsePlaywrightReadme } from "./official.js";
import { fetchSmithery, fetchText, parseSmitheryCache } from "./smithery.js";
import { TOOLKIT } from "./toolkit.js";
import type { CalibratedServer, Calibration, RetrieveOptions, SmitheryDetail } from "./types.js";

export const FARMS = new Set(["axel-belfort"]);
export const TOOL_CAP = 100;
export const USE_FLOOR = 2000;

const PLAYWRIGHT_README = "https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md";
const CHROME_TOOLS = "https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md";

export type DefaultPaths = {
  readonly cachePath: string;
  readonly outPath: string;
  readonly docsDir: string;
  readonly catalogDir: string;
};

export function findRepoRoot(start = process.cwd()): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isPrettyMcpRoot(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    return (
      typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === "@inhuman.tools/pretty-mcp"
    );
  } catch {
    return false;
  }
}

export function findPrettyMcpRoot(start = process.cwd()): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const seed of [start, here]) {
    let dir = path.resolve(seed);
    for (;;) {
      if (isPrettyMcpRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export function defaultPaths(cwd = process.cwd()): DefaultPaths {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const repo = findRepoRoot(cwd) ?? findRepoRoot(here);
  const pkg = findPrettyMcpRoot(cwd) ?? cwd;
  const cachePath =
    repo === undefined
      ? path.join(cwd, "smithery-details.json")
      : path.join(repo, ".tmp-mcp-inventory", "smithery-details.json");
  return {
    cachePath,
    outPath: path.join(pkg, "calibration.json"),
    docsDir: path.dirname(cachePath),
    catalogDir: path.join(pkg, "catalog"),
  };
}

export function namespaceOf(qualifiedName: string): string {
  const slash = qualifiedName.indexOf("/");
  return slash === -1 ? qualifiedName : qualifiedName.slice(0, slash);
}

function listedToolCount(detail: SmitheryDetail): number {
  return detail.toolCount > 0 ? detail.toolCount : detail.tools.length;
}

export function admitSmithery(detail: SmitheryDetail): boolean {
  const n = listedToolCount(detail);
  if (FARMS.has(namespaceOf(detail.qualifiedName))) return false;
  if (detail.useCount < USE_FLOOR) return false;
  if (n === 0 || n > TOOL_CAP) return false;
  return true;
}

export function isMegaSkipped(detail: SmitheryDetail): boolean {
  return listedToolCount(detail) > TOOL_CAP && detail.useCount >= USE_FLOOR;
}

export function serverFromSmithery(detail: SmitheryDetail): CalibratedServer {
  return {
    id: detail.qualifiedName,
    displayName: detail.displayName ?? detail.qualifiedName,
    source: "smithery",
    description: detail.description,
    useCount: detail.useCount,
    verified: detail.verified,
    tools: detail.tools,
  };
}

export function argHistogram(servers: readonly CalibratedServer[], top = 40): Record<string, number> {
  const counts = new Map<string, number>();
  for (const server of servers) {
    for (const tool of server.tools) {
      for (const arg of tool.args) {
        counts.set(arg.name, (counts.get(arg.name) ?? 0) + 1);
      }
    }
  }
  return Object.fromEntries(
    [...counts.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top),
  );
}

export function assembleCalibration(
  details: readonly SmitheryDetail[],
  official: readonly CalibratedServer[],
  asOf = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): Calibration {
  const servers: CalibratedServer[] = [TOOLKIT, ...official];
  let megaSkipped = 0;
  for (const detail of details) {
    if (isMegaSkipped(detail)) megaSkipped += 1;
    if (admitSmithery(detail)) servers.push(serverFromSmithery(detail));
  }
  return {
    asOf,
    purpose: "Calibration for an identity-scheme definition API. Not a unique-user census.",
    cut: {
      toolkit: "harness dist FS + shell + scheme_repl",
      official: "Playwright / Chrome DevTools READMEs when present next to the cache",
      smithery: `useCount ≥ ${USE_FLOOR}, 1–${TOOL_CAP} tools, not ${[...FARMS].toSorted().join(",")}`,
    },
    counts: {
      servers: servers.length,
      tools: servers.reduce((n, server) => n + server.tools.length, 0),
      smitheryAdmitted: servers.filter((server) => server.source === "smithery").length,
      megaSkipped,
    },
    argNames: argHistogram(servers),
    servers,
  };
}

export async function loadOfficial(docsDir: string): Promise<CalibratedServer[]> {
  const out: CalibratedServer[] = [];
  const playwrightPath = path.join(docsDir, "playwright-readme.md");
  const chromePath = path.join(docsDir, "chrome-tools.md");
  if (existsSync(playwrightPath)) {
    const rec = parsePlaywrightReadme(await readFile(playwrightPath, "utf8"));
    if (rec !== undefined) out.push(rec);
  }
  if (existsSync(chromePath)) {
    const rec = parseChromeToolReference(await readFile(chromePath, "utf8"));
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

export async function fetchOfficialDocs(docsDir: string): Promise<void> {
  await mkdir(docsDir, { recursive: true });
  for (const [url, file] of [
    [PLAYWRIGHT_README, "playwright-readme.md"],
    [CHROME_TOOLS, "chrome-tools.md"],
  ] as const) {
    try {
      await writeFile(path.join(docsDir, file), await fetchText(url));
    } catch (error) {
      process.stderr.write(`official ${file} fetch failed: ${error}\n`);
    }
  }
}

export async function retrieve(options: RetrieveOptions): Promise<Calibration> {
  let details: SmitheryDetail[];
  if (options.fetch) {
    await fetchOfficialDocs(options.docsDir ?? path.dirname(options.cachePath));
    details = await fetchSmithery(options.cachePath);
  } else if (existsSync(options.cachePath)) {
    details = parseSmitheryCache(JSON.parse(await readFile(options.cachePath, "utf8")));
    process.stderr.write(`cache ${options.cachePath} n=${details.length}\n`);
  } else {
    throw new Error(`no cache at ${options.cachePath}; pass --fetch`);
  }

  const official = await loadOfficial(options.docsDir ?? path.dirname(options.cachePath));
  for (const rec of official) {
    process.stderr.write(`official ${rec.id} tools=${rec.tools.length}\n`);
  }

  const payload = assembleCalibration(details, official);
  await mkdir(path.dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(payload.counts, null, 2)}\n`);
  process.stderr.write(`argNames ${JSON.stringify(payload.argNames)}\n`);
  process.stderr.write(`wrote ${options.outPath}\n`);
  return payload;
}

export class HelpRequested extends Error {
  constructor() {
    super("help");
    this.name = "HelpRequested";
  }
}

export function parseArgv(argv: string[], defaults: DefaultPaths = defaultPaths()): RetrieveOptions {
  const args = argv[0] === "retrieve" ? argv.slice(1) : [...argv];
  let fetchFlag = false;
  let cachePath = defaults.cachePath;
  let outPath = defaults.outPath;
  let docsDir = defaults.docsDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = (): string => {
      i += 1;
      if (i >= args.length) throw new Error(`${arg} needs a path`);
      return args[i]!;
    };
    switch (arg) {
      case "--fetch": {
        fetchFlag = true;
        break;
      }
      case "--cache": {
        cachePath = next();
        break;
      }
      case "--out": {
        outPath = next();
        break;
      }
      case "--docs-dir": {
        docsDir = next();
        break;
      }
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { fetch: fetchFlag, cachePath, outPath, docsDir };
}
