import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const turn = join(repository, "packages-runtime/turn");
const fixtures = join(repository, "scripts/session-runtime-fixtures");

function packageAt(from, name) {
  let cursor = from;
  for (;;) {
    const candidate = join(cursor, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function dependencyGraph() {
  const graph = new Map();
  function visit(directory) {
    if (graph.has(directory)) return graph.get(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const node = { directory, manifest, dependencies: new Map(), id: graph.size };
    graph.set(directory, node);
    for (const [name] of Object.entries({ ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies })) {
      const dependency = packageAt(directory, name);
      if (!dependency) {
        assert.ok(!(name in (manifest.dependencies ?? {})), `Missing installed dependency ${name} of ${manifest.name}`);
        continue;
      }
      node.dependencies.set(name, visit(dependency));
    }
    return node;
  }
  const root = visit(realpathSync(turn));
  const nodeTypes = packageAt(turn, "@types/node");
  assert.ok(nodeTypes, "Install workspace development dependencies before qualification");
  const types = visit(nodeTypes);
  return { graph, root, types };
}

function linkPackage(name, target, consumer) {
  const destination = join(consumer, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(relative(dirname(destination), target), destination, "dir");
  assert.ok(realpathSync(destination).startsWith(consumer.split(`${sep}modules${sep}`)[0]), `Dependency link escaped candidate: ${destination}`);
}

test("packed session runtime preserves an old Kley conversation in an isolated consumer", { timeout: 180_000 }, () => {
  const candidate = realpathSync(mkdtempSync(join(tmpdir(), "inhuman-runtime-consumer-")));
  try {
    const { graph, root, types } = dependencyGraph();
    for (const node of graph.values()) {
      node.installed = join(candidate, "modules", String(node.id));
      mkdirSync(node.installed, { recursive: true });
      const inRepository = !relative(repository, node.directory).startsWith("..") && !node.directory.includes(`${sep}node_modules${sep}`);
      if (inRepository) {
        assert.ok(existsSync(join(node.directory, "dist")), `Build ${node.manifest.name} before qualification`);
        const archive = join(candidate, `${node.id}.tgz`);
        execFileSync("pnpm", ["pack", "--out", archive, "--json"], { cwd: node.directory, stdio: "pipe" });
        execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", node.installed], { stdio: "pipe" });
        assert.ok(existsSync(join(node.installed, "dist")), `${node.manifest.name} tarball omits its compiled entry`);
      } else {
        cpSync(node.directory, node.installed, {
          recursive: true,
          dereference: true,
          filter: (source) => !relative(node.directory, source).split(sep).includes("node_modules"),
        });
      }
    }
    for (const node of graph.values()) {
      for (const [name, dependency] of node.dependencies) linkPackage(name, dependency.installed, node.installed);
    }
    for (const node of [root, types, ...root.dependencies.values()]) linkPackage(node.manifest.name, node.installed, candidate);
    cpSync(fixtures, candidate, { recursive: true });
    writeFileSync(join(candidate, "package.json"), JSON.stringify({ type: "module", private: true }));
    writeFileSync(join(candidate, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"] },
      files: ["consumer.ts"],
    }));
    const compiler = packageAt(turn, "typescript");
    assert.ok(compiler);
    execFileSync(process.execPath, [join(compiler, "bin/tsc"), "-p", join(candidate, "tsconfig.json")], { cwd: candidate, stdio: "pipe" });
    const output = execFileSync(process.execPath, ["--no-warnings", "--loader", join(candidate, "loader.mjs"), join(candidate, "consumer.mjs")], {
      cwd: candidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    });
    assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1)), { oldVersion: "0.1.0", continued: true, effectCalls: 1, compacted: true, moduleEscapeDenied: true });
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
});
