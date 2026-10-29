/* eslint-disable security/detect-non-literal-fs-filename -- walks src to resolve @/ and dist to rewrite emit */
// `@/*` is packages/harness/src/* (tsconfig.paths.json). NodeNext leaves that
// specifier in the emit. This rewrites dist to a relative file after tsc.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
export const packageRoot = join(scriptDir, "..");
export const srcRoot = join(packageRoot, "src");

const EMIT_EXT = new Map([
  [".ts", ".js"],
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
]);

const SPECIFIER_RES = [
  /\bfrom\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s+(["'])([^"'\n]+)\1/g,
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1/g,
];

/** `@/` → this package's src. A string prefix, so `@here.build` is not a match. */
export function vitestAliases() {
  return [{ find: "@/", replacement: `${srcRoot}/` }];
}

/**
 * @param {string} moduleUrl
 */
export function isDirectScript(moduleUrl) {
  if (process.argv.length < 2) return false;
  const entry = process.argv[1];
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

/**
 * @param {string} spec
 * @returns {string | undefined}
 */
export function srcFileForAlias(spec) {
  if (!spec.startsWith("@/")) return undefined;
  const rest = spec.slice(2);
  if (rest === "" || rest.startsWith("/") || rest.includes("..") || rest.includes("\\")) return undefined;
  const base = join(srcRoot, rest);
  for (const ext of EMIT_EXT.keys()) {
    const file = base + ext;
    if (existsSync(file)) return file;
  }
  for (const ext of EMIT_EXT.keys()) {
    const file = join(base, `index${ext}`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * @param {string} srcFile
 */
export function distFileForSrc(srcFile) {
  const ext = extname(srcFile);
  const emitExt = EMIT_EXT.get(ext);
  if (emitExt === undefined) throw new Error(`alias target is not TypeScript: ${srcFile}`);
  const stem = relative(srcRoot, srcFile).slice(0, -ext.length);
  return join(packageRoot, "dist", `${stem}${emitExt}`);
}

/**
 * @param {string} fromFile
 * @param {string} distFile
 */
export function relativeSpecifier(fromFile, distFile) {
  const rel = relative(dirname(fromFile), distFile).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * @param {string} source
 * @param {string} fromFile
 */
export function rewriteSpecifierText(source, fromFile) {
  let next = source;
  for (const pattern of SPECIFIER_RES) {
    next = next.replaceAll(pattern, (match, quote, spec) => {
      if (!spec.startsWith("@/")) return match;
      const srcFile = srcFileForAlias(spec);
      if (srcFile === undefined) throw new Error(`${fromFile}: no source for ${spec}`);
      const head = match.slice(0, match.indexOf(quote));
      return `${head}${quote}${relativeSpecifier(fromFile, distFileForSrc(srcFile))}${quote}`;
    });
  }
  return next;
}

/**
 * @param {string} name
 */
function isEmitFile(name) {
  return (
    name.endsWith(".js") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs") ||
    name.endsWith(".d.ts") ||
    name.endsWith(".d.mts") ||
    name.endsWith(".d.cts")
  );
}

/**
 * @param {string} distDir
 */
function rewriteTree(distDir) {
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    const full = join(distDir, entry.name);
    if (entry.isDirectory()) {
      rewriteTree(full);
      continue;
    }
    if (!entry.isFile() || !isEmitFile(entry.name) || entry.name.endsWith(".map")) continue;
    const source = readFileSync(full, "utf8");
    const next = rewriteSpecifierText(source, full);
    if (next !== source) writeFileSync(full, next);
  }
}

if (isDirectScript(import.meta.url)) {
  const distDir = join(packageRoot, "dist");
  if (existsSync(distDir)) rewriteTree(distDir);
}
