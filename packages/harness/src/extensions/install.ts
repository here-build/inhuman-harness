/**
 * `harness install <pkg>`: stream `npm install --save --ignore-scripts` into the
 * kernel folder, then record the installed plugin.json name as enabled.
 * Omit is already enabled; a prior `{ enabled: false }` is deleted.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { adjustJson } from "./adjust-json.js";

const KERNEL_PACKAGE = {
  name: "harness-kernel",
  private: true,
  dependencies: {},
};

/** The part of a shell context {@link installPlugin} writes to; the daemon passes a capture instead of a terminal. */
export type InstallStreams = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly writeErr: (error: unknown) => void;
};

export type InstallNpm = (options: {
  readonly kernel: string;
  readonly pkg: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}) => Promise<number>;

export async function installPlugin(
  streams: InstallStreams,
  kernel: string,
  pkg: string,
  npm: InstallNpm = streamNpmInstall,
): Promise<number> {
  const spec = pkg.trim();
  if (spec === "") {
    streams.writeErr("harness install requires a package");
    return 2;
  }
  mkdirSync(kernel, { recursive: true });
  const manifest = join(kernel, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify(KERNEL_PACKAGE, null, 2)}\n`);
  }
  const code = await npm({
    kernel,
    pkg: spec,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  if (code !== 0) return code || 1;

  const wanted = installedNpmName(spec) ?? packageNameOf(spec);
  const installed = readInstalledPlugin(kernel, wanted);
  if (installed === null) {
    streams.writeErr(`installed ${spec} but it has no plugin.json`);
    return 1;
  }
  adjustJson(join(kernel, "config.json"), (raw) => enablePlugin(raw, installed.pluginName));
  streams.stdout.write(`enabled plugin \`${installed.pluginName}\` from \`${installed.npmName}\`\n`);
  return 0;
}

/** Package root on disk. `exports` often hides `plugin.json`, so do not `require.resolve` it. */
function readInstalledPlugin(kernel: string, npmName: string): { pluginName: string; npmName: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(kernel, "node_modules", npmName, "plugin.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof parsed.name !== "string" || parsed.name.trim() === "") return null;
    return { pluginName: parsed.name.trim(), npmName };
  } catch {
    return null;
  }
}

export function streamNpmInstall(options: {
  readonly kernel: string;
  readonly pkg: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--save", "--ignore-scripts", options.pkg], {
      cwd: options.kernel,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(options.stdout, { end: false });
    child.stderr.pipe(options.stderr, { end: false });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * npm name of a directory spec (`file:` URL, absolute path, or `./` path).
 * A registry spec returns null so the version-stripping rules stay in {@link packageNameOf}.
 */
export function installedNpmName(spec: string): string | null {
  const dir = directoryOfSpec(spec.trim());
  if (dir == null) return null;
  return packageNameIn(dir);
}

function directoryOfSpec(spec: string): string | null {
  if (spec.startsWith("file:")) {
    try {
      return fileURLToPath(spec);
    } catch {
      return null;
    }
  }
  if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../")) return spec;
  return null;
}

function packageNameIn(dir: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (raw == null || typeof raw !== "object" || !("name" in raw)) return null;
  const name = raw.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

/** npm spec → package name. Scoped names keep the scope; a version or tag is dropped. */
export function packageNameOf(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash === -1) return trimmed;
    const rest = trimmed.slice(slash + 1);
    const cut = rest.search(/@/);
    return cut < 0 ? trimmed : trimmed.slice(0, slash + 1 + cut);
  }
  const at = trimmed.lastIndexOf("@");
  return at <= 0 ? trimmed : trimmed.slice(0, at);
}

function enablePlugin(raw: unknown, pluginName: string): Record<string, unknown> {
  const config =
    raw != null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const pluginsRaw = config.plugins;
  const plugins =
    pluginsRaw != null && typeof pluginsRaw === "object" && !Array.isArray(pluginsRaw)
      ? { ...(pluginsRaw as Record<string, unknown>) }
      : {};
  const row = plugins[pluginName];
  if (row != null && typeof row === "object" && !Array.isArray(row)) {
    const next = { ...(row as Record<string, unknown>) };
    delete next.enabled;
    if (Object.keys(next).length === 0) delete plugins[pluginName];
    else plugins[pluginName] = next;
  } else {
    delete plugins[pluginName];
  }
  if (Object.keys(plugins).length === 0) delete config.plugins;
  else config.plugins = plugins;
  return config;
}
