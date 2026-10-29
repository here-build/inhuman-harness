#!/usr/bin/env node

import {
  catalogPath,
  generateCatalog,
  loadCalibration,
  loadCatalogDir,
  readCatalogFile,
  uncoveredFrom,
  uncoveredSerializersFrom,
} from "./catalog.js";
import { renderTool, splitIdentity, type RenderKind } from "./render.js";
import { defaultPaths, HelpRequested, parseArgv, retrieve } from "./retrieve.js";

const USAGE = `pretty-mcp retrieve [--fetch] [--cache <path>] [--out <path>] [--docs-dir <path>]
pretty-mcp generate [--calibration <path>] [--catalog <dir>]
pretty-mcp uncovered [--calibration <path>] [--catalog <dir>] [--limit <n>] [--json] [--serializers]
pretty-mcp render --server <id> --tool <name> [--kind question|effect|result] [--line] [--args <json>] [--result <json>] [--catalog <dir>]

retrieve   rebuild calibration.json from the Smithery cache
generate   write per-server catalog files (schemas from calibration; keep templates)
uncovered  list tools with empty question or effect (residual queue)
           --serializers lists identity-covered tools still missing a result template
render     mustache → markdown
`;

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  if (i + 1 >= args.length) throw new Error(`${flag} needs a value`);
  const value = args[i + 1]!;
  if (value.startsWith("--")) throw new Error(`${flag} needs a value`);
  args.splice(i, 2);
  return value;
}

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function peel(argv: string[]): string[] {
  return argv.length > 0 && argv[0] === "--" ? argv.slice(1) : argv;
}

async function runGenerate(argv: string[]): Promise<void> {
  argv = peel(argv);
  const defaults = defaultPaths();
  const calibrationPath = take(argv, "--calibration") ?? defaults.outPath;
  const catalogDir = take(argv, "--catalog") ?? defaults.catalogDir;
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
  const counts = await generateCatalog(await loadCalibration(calibrationPath), catalogDir);
  process.stderr.write(`${JSON.stringify(counts)}\n`);
  process.stderr.write(`catalog ${catalogDir}\n`);
}

async function runUncovered(argv: string[]): Promise<void> {
  argv = peel(argv);
  const defaults = defaultPaths();
  const calibrationPath = take(argv, "--calibration") ?? defaults.outPath;
  const catalogDir = take(argv, "--catalog") ?? defaults.catalogDir;
  const limitRaw = take(argv, "--limit");
  const asJson = takeFlag(argv, "--json");
  const serializers = takeFlag(argv, "--serializers");
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
  const calibration = await loadCalibration(calibrationPath);
  const catalog = await loadCatalogDir(catalogDir);
  const all = serializers ? uncoveredSerializersFrom(calibration, catalog) : uncoveredFrom(calibration, catalog);
  const limit = limitRaw === undefined ? 50 : Number(limitRaw);
  const slice = limit === 0 ? all : all.slice(0, limit);
  const payload = {
    counts: {
      tools: calibration.counts.tools,
      uncovered: all.length,
      shown: slice.length,
    },
    uncovered: slice,
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const noun = serializers ? "uncovered serializers" : "uncovered";
  process.stdout.write(`${payload.counts.uncovered} ${noun} of ${payload.counts.tools}\n`);
  for (const row of slice) {
    process.stdout.write(`${row.server}\t${row.tool}\n`);
  }
}

async function runRender(argv: string[]): Promise<void> {
  argv = peel(argv);
  const defaults = defaultPaths();
  const catalogDir = take(argv, "--catalog") ?? defaults.catalogDir;
  const server = take(argv, "--server");
  const toolName = take(argv, "--tool");
  const kindRaw = take(argv, "--kind") ?? "effect";
  const lineOnly = takeFlag(argv, "--line");
  const argsRaw = take(argv, "--args") ?? "{}";
  const resultRaw = take(argv, "--result");
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
  if (server === undefined || toolName === undefined) throw new Error("--server and --tool are required");
  if (kindRaw !== "question" && kindRaw !== "effect" && kindRaw !== "result") {
    throw new Error("--kind must be question, effect, or result");
  }
  const kind: RenderKind = kindRaw;
  const file = await readCatalogFile(catalogPath(catalogDir, server));
  if (file === undefined) throw new Error(`no catalog file for ${server}`);
  if (!(toolName in file.tools)) throw new Error(`no tool ${toolName} on ${server}`);
  const tool = file.tools[toolName]!;
  const rendered = renderTool(
    tool,
    kind,
    parseJsonObject(argsRaw, "--args"),
    resultRaw === undefined ? undefined : JSON.parse(resultRaw),
  );
  if (!rendered.ok) throw new Error(rendered.error);
  const text = lineOnly ? splitIdentity(rendered.markdown).line : rendered.markdown;
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const command = argv.length === 0 ? "--help" : argv[0]!;
    if (command === "--help" || command === "-h") throw new HelpRequested();
    if (command === "generate") {
      await runGenerate(argv.slice(1));
      return;
    }
    if (command === "uncovered") {
      await runUncovered(argv.slice(1));
      return;
    }
    if (command === "render") {
      await runRender(argv.slice(1));
      return;
    }
    await retrieve(parseArgv(argv, defaultPaths()));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(USAGE);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

void main();
