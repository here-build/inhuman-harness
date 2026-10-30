// Release closure check: everything `inhuman` needs at runtime must be publishable,
// and no public workspace package may depend on a private one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "inhuman";
const DEP_FIELDS = ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"];

function workspaceGlobs() {
  const text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  return [...text.matchAll(/^\s*-\s+"([^"]+)"/gm)].map((m) => m[1]).filter((g) => g.endsWith("/*"));
}

export function loadWorkspace() {
  const byName = new Map();
  for (const glob of workspaceGlobs()) {
    const parent = join(ROOT, glob.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const file = join(parent, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (manifest.name) byName.set(manifest.name, { dir: `${glob.slice(0, -2)}/${entry.name}`, manifest });
    }
  }
  return byName;
}

// Runtime dependency names of a manifest that resolve to workspace packages.
function runtimeDeps(manifest, ws) {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const optionalPeers = manifest.peerDependenciesMeta ?? {};
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (!optionalPeers[name]?.optional) names.add(name);
  }
  return [...names].filter((n) => ws.has(n));
}

function allDeps(manifest, ws) {
  const names = new Set();
  for (const field of DEP_FIELDS) for (const n of Object.keys(manifest[field] ?? {})) if (ws.has(n)) names.add(n);
  return [...names];
}

export function checkRelease() {
  const ws = loadWorkspace();
  const problems = [];
  if (!ws.has(ENTRY)) return { closure: [], problems: [`entry package "${ENTRY}" not found`] };

  const closure = new Map();
  const queue = [ENTRY];
  while (queue.length) {
    const name = queue.pop();
    if (closure.has(name)) continue;
    const { manifest } = ws.get(name);
    closure.set(name, manifest);
    queue.push(...runtimeDeps(manifest, ws));
  }

  for (const [name, manifest] of closure) {
    if (manifest.private) problems.push(`${name} is in the runtime closure of ${ENTRY} but is private`);
    if (manifest.publishConfig?.access !== "public") problems.push(`${name} has no publishConfig.access: public`);
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) problems.push(`${name} has no "files"`);
    if (!manifest.version) problems.push(`${name} has no version`);
    for (const dep of allDeps(manifest, ws)) {
      if (ws.get(dep).manifest.private && runtimeDeps(manifest, ws).includes(dep)) {
        problems.push(`${name} depends on private workspace package ${dep}`);
      }
    }
  }

  // Public packages outside the closure would also be published by `pnpm -r publish`.
  for (const [name, { manifest }] of ws) {
    if (closure.has(name) || manifest.private) continue;
    for (const dep of runtimeDeps(manifest, ws)) {
      if (ws.get(dep).manifest.private) problems.push(`${name} (public, outside the closure) depends on private ${dep}`);
    }
  }

  return { closure: [...closure].map(([name, m]) => `${name}@${m.version}`).sort(), problems, ws };
}

// Packages `pnpm -r publish` would try to publish: every non-private workspace package.
export function publishable(ws) {
  return [...ws].filter(([, { manifest }]) => !manifest.private).map(([n, { manifest }]) => `${n}@${manifest.version}`).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { closure, problems, ws } = checkRelease();
  console.log(`Runtime closure of ${ENTRY} (${closure.length}):`);
  for (const line of closure) console.log(`  ${line}`);
  const all = publishable(ws);
  console.log(`\nWould be published by pnpm -r publish (${all.length}):`);
  for (const line of all) console.log(`  ${line}`);
  if (problems.length) {
    console.error(`\nRelease check failed:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nRelease check passed.");
}
