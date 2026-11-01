import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const manifest = JSON.parse(read("plugin.json"));
const pkg = JSON.parse(read("package.json"));
const extension = manifest.extensions["tools.inhuman"];

test("ships the official public local Cua MCP transport without permission bypass flags", () => {
  assert.deepEqual({
    name: manifest.name,
    version: manifest.version,
    mcp: extension.mcp,
    bots: extension.bots ?? [],
    dependencies: Object.keys(pkg.dependencies ?? {}),
    installHook: pkg.scripts.postinstall ?? null,
  }, {
    name: "cua",
    version: pkg.version,
    mcp: [{ name: "cua-driver", command: "cua-driver", args: ["mcp"], visibility: "public", scope: "global" }],
    bots: [], dependencies: [], installHook: null,
  });
});

test("the package includes its advertised assets and an identifiable computer-use skill", () => {
  const assets = pkg.files.map((path) => ({ path, directory: statSync(new URL(path, root)).isDirectory() }));
  const skill = read("skills/cua/SKILL.md");
  assert.deepEqual({ assets, skills: extension.skills, name: /^---\r?\nname: ([^\r\n]+)/.exec(skill)?.[1] }, {
    assets: [{ path: "plugin.json", directory: false }, { path: "skills/", directory: true }, { path: "README.md", directory: false }],
    skills: ["./skills/cua"], name: "cua",
  });
});
