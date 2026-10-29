#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateArtifacts } from "./generate.js";

// dist/spec/cli.js -> packages/harness-contract; the spec lives in its spec/ folder.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const defaultOut = resolve(packageRoot, "spec");

const args = process.argv.slice(2);
const check = args.includes("--check");
const outFlag = args.indexOf("--out");
const out = outFlag === -1 ? defaultOut : resolve(args[outFlag + 1] ?? defaultOut);

const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const version =
  typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
    ? manifest.version
    : "0.0.0";

const artifacts = await generateArtifacts(version);

if (check) {
  const stale = artifacts.filter((artifact) => {
    try {
      return readFileSync(join(out, artifact.file), "utf8") !== artifact.text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `spec/ is stale: ${stale.map((artifact) => artifact.file).join(", ")}. Run: pnpm --filter @inhuman.tools/harness-contract spec`,
    );
    process.exit(1);
  }
  console.log("spec/ is up to date");
} else {
  mkdirSync(out, { recursive: true });
  for (const artifact of artifacts) writeFileSync(join(out, artifact.file), artifact.text);
  console.log(`wrote ${artifacts.map((artifact) => artifact.file).join(", ")} to ${out}`);
}
