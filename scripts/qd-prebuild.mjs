/**
 * Build one qd release binary and copy it into its platform package.
 *
 * Ubuntu 22.04 is the glibc floor (2.35). Pass --target to cross-compile.
 * With no flag, the host triple is built. A Mac whose Xcode license is not
 * accepted needs DEVELOPER_DIR=/Library/Developer/CommandLineTools.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const manifest = join(workspace, "packages/quickdraw/rust/qd/Cargo.toml");

const TARGETS = [
  { rust: "aarch64-apple-darwin", dir: "qd-darwin-arm64", host: "darwin-arm64" },
  { rust: "x86_64-apple-darwin", dir: "qd-darwin-x64", host: "darwin-x64" },
  { rust: "x86_64-unknown-linux-gnu", dir: "qd-linux-x64", host: "linux-x64" },
  { rust: "aarch64-unknown-linux-gnu", dir: "qd-linux-arm64", host: "linux-arm64" },
];

function selected() {
  const index = process.argv.indexOf("--target");
  if (index === -1) {
    const host = `${process.platform}-${process.arch}`;
    const match = TARGETS.find((target) => target.host === host);
    if (!match) {
      throw new Error(`qd-prebuild: no target for ${host}. Pass --target <rust-triple>`);
    }
    return [match];
  }
  const rust = process.argv[index + 1];
  const match = TARGETS.find((target) => target.rust === rust);
  if (!match) {
    throw new Error(
      `qd-prebuild: unknown target ${rust ?? ""}. Known: ${TARGETS.map((target) => target.rust).join(", ")}`,
    );
  }
  return [match];
}

let targets;
try {
  targets = selected();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const target of targets) {
  const built = spawnSync(
    "cargo",
    ["build", "--release", "--target", target.rust, "--manifest-path", manifest],
    { cwd: workspace, stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
  const from = join(workspace, "packages/quickdraw/rust/qd/target", target.rust, "release", "qd");
  const to = join(workspace, "packages", target.dir, "qd");
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  // The linker signature is not a valid page signature on this OS. An unsigned
  // copy is SIGKILL'd before main, and the host treats that as a live UI.
  if (target.rust.includes("apple")) {
    const signed = spawnSync("codesign", ["--force", "--sign", "-", to], { stdio: "inherit" });
    if (signed.status !== 0) process.exit(signed.status ?? 1);
  }
  console.log(`qd-prebuild: ${target.rust} -> ${to}`);
}
