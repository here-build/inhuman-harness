import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as serverFx from "./packed-product/fixtures/harness-server.mjs";
import * as yjsFx from "./packed-product/fixtures/harness-yjs-server.mjs";
import * as runtimeServerFx from "./packed-product/fixtures/harness-runtime-server.mjs";
import * as webFx from "./packed-product/fixtures/harness-provider-web.mjs";
import * as restFx from "./packed-product/fixtures/rest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];
const importFrom = /(?:from|import)\s+["']([^"']+)["']/g;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo"]);

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function posix(p) {
  return p.split(sep).join("/");
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function productPackages() {
  const out = [];
  for (const forest of ["packages", "plugins"]) {
    const parent = join(ROOT, forest);
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const dir = join(parent, name.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      out.push({ dir, manifest: readJson(manifestPath) });
    }
  }
  return out;
}

function walkRelative(entry, seen = new Set()) {
  const file = entry.endsWith(".ts") ? entry : `${entry}.ts`;
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const text = readFileSync(file, "utf8");
  const next = [file];
  for (const match of text.matchAll(importFrom)) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue;
    next.push(...walkRelative(join(dirname(file), spec.replace(/\.js$/, ".ts")), seen));
  }
  return next;
}

function specsOf(files) {
  const specs = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importFrom)) specs.push({ file, spec: match[1] });
  }
  return specs;
}

function packList(packageDir) {
  const dest = mkdtempSync(join(tmpdir(), "packed-product-"));
  temps.push(dest);
  execFileSync("npm", ["pack", "--pack-destination", dest], {
    cwd: packageDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarballs = readdirSync(dest).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `expected one tarball in ${packageDir}`);
  const listing = execFileSync("tar", ["-tzf", join(dest, tarballs[0])], { encoding: "utf8" });
  return listing
    .split("\n")
    .map((line) => line.replace(/^package\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

test("public client barrels do not load composition or providers", () => {
  const forbidden = [...restFx.barrelForbidden, runtimeServerFx.barrelForbidden, serverFx.compositionNeedle];
  const barrels = [join(ROOT, serverFx.barrel), ...restFx.barrels.map((rel) => join(ROOT, rel))];
  const hits = [];
  for (const barrel of barrels) {
    for (const { file, spec } of specsOf(walkRelative(barrel))) {
      if (forbidden.some((needle) => spec.includes(needle))) {
        hits.push(`${posix(relative(ROOT, file))}: ${spec}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("lower packages do not import harness-server/testkit", () => {
  const composition = new Set(restFx.compositionPackages);
  const hits = [];
  for (const pkg of productPackages()) {
    if (composition.has(pkg.manifest.name) || pkg.dir.includes(`${sep}plugins${sep}`)) continue;
    for (const file of walkFiles(pkg.dir)) {
      const text = readFileSync(file, "utf8");
      if (serverFx.testkitSpecifiers.some((needle) => text.includes(needle))) {
        hits.push(posix(relative(ROOT, file)));
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("one harness-model and one connection intern table", () => {
  const models = productPackages().filter((pkg) => pkg.manifest.name === restFx.modelPackage);
  assert.equal(models.length, 1);
  const internFiles = [];
  for (const pkg of productPackages()) {
    for (const file of walkFiles(join(pkg.dir, "src"))) {
      const text = readFileSync(file, "utf8");
      if (text.includes(restFx.internSymbol)) internFiles.push(posix(relative(ROOT, file)));
    }
  }
  assert.deepEqual(internFiles, [restFx.internFile]);
  const connectionsIntern = readFileSync(join(ROOT, restFx.connectionsIntern), "utf8");
  assert.match(connectionsIntern, restFx.connectionsImport);
  assert.doesNotMatch(connectionsIntern, /internByKernel/);
  for (const pkg of productPackages()) {
    const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies };
    const spec = deps[restFx.modelPackage];
    if (spec !== undefined) assert.equal(spec, restFx.modelRange, `${pkg.manifest.name} must use the workspace harness-model`);
  }
});

test("packed product files include bins, exports, and shipped assets", () => {
  const byName = new Map(productPackages().map((pkg) => [pkg.manifest.name, pkg]));

  const server = byName.get(serverFx.packageName);
  assert.ok(server);
  assert.equal(server.manifest.bin?.[serverFx.binName], serverFx.binPath);
  for (const key of serverFx.exportPaths) assert.ok(server.manifest.exports[key]);
  assert.deepEqual(server.manifest.files, serverFx.files);
  const serverPacked = packList(server.dir);
  for (const required of serverFx.packedIncludes) {
    assert.ok(serverPacked.includes(required), `${serverFx.packLabel} pack missing ${required}`);
  }

  const cli = byName.get(restFx.cli.packageName);
  assert.ok(cli);
  assert.equal(cli.manifest.bin?.[restFx.cli.binName], restFx.cli.binPath);
  for (const file of restFx.cli.filesInclude) assert.ok(cli.manifest.files.includes(file));
  const cliPacked = packList(cli.dir);
  for (const required of restFx.cli.packedIncludes) {
    assert.ok(cliPacked.includes(required), restFx.cli.packMissing);
  }

  // A fused package is no longer its own directory. The harness fixture covers the fused package.
  const yjs = byName.get(yjsFx.packageName);
  if (yjs) {
    assert.equal(yjs.manifest.bin?.[yjsFx.binName], yjsFx.binPath);
    for (const file of yjsFx.filesInclude) assert.ok(yjs.manifest.files.includes(file));
    for (const key of yjsFx.exportPaths) assert.ok(yjs.manifest.exports[key]);
  }

  const runtimeServer = byName.get(runtimeServerFx.packageName);
  if (runtimeServer) {
    for (const file of runtimeServerFx.filesInclude) assert.ok(runtimeServer.manifest.files.includes(file));
    for (const key of runtimeServerFx.exportPaths) assert.ok(runtimeServer.manifest.exports[key]);
    assert.equal(runtimeServer.manifest.bin, undefined);
  }

  const hypervisor = byName.get(restFx.hypervisor.packageName);
  if (hypervisor) {
    for (const file of restFx.hypervisor.filesInclude) assert.ok(hypervisor.manifest.files.includes(file));
    for (const key of restFx.hypervisor.exportPaths) assert.ok(hypervisor.manifest.exports[key]);
  }

  const web = byName.get(webFx.packageName);
  if (web) {
    for (const key of webFx.exportPaths) assert.ok(web.manifest.exports[key]);
  }

  const openai = byName.get(restFx.openai.packageName);
  if (openai) {
    for (const key of restFx.openai.exportPaths) assert.ok(openai.manifest.exports[key]);
  }
});
