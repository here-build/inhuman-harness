import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { expect, it } from "vitest";

import { installPlugin, installedNpmName, packageNameOf, type InstallNpm, type InstallStreams } from "../install.js";

function capture(): { streams: InstallStreams; text: () => { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  const err = new Writable({
    write(chunk, _enc, cb) {
      stderr += String(chunk);
      cb();
    },
  });
  const streams: InstallStreams = {
    stdout: new Writable({
      write(chunk, _enc, cb) {
        stdout += String(chunk);
        cb();
      },
    }),
    stderr: err,
    writeErr: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      err.write(message.endsWith("\n") ? message : `${message}\n`);
    },
  };
  return {
    streams,
    text: () => ({ stdout, stderr }),
  };
}

function kernelWith(pluginNpm: string, pluginName: string, packageJson: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "harness-install-"));
  const dir = join(root, "node_modules", ...pluginNpm.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "harness-kernel", private: true, dependencies: { [pluginNpm]: "0.0.1" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: pluginNpm, version: "0.0.1", ...packageJson })}\n`,
  );
  writeFileSync(join(dir, "plugin.json"), `${JSON.stringify({ name: pluginName })}\n`);
  return root;
}

it("a directory spec installs under the package.json name", async () => {
  const source = mkdtempSync(join(tmpdir(), "harness-install-src-"));
  writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "@scope/demo", version: "0.0.1" })}\n`);
  writeFileSync(join(source, "plugin.json"), `${JSON.stringify({ name: "demo" })}\n`);
  const kernel = mkdtempSync(join(tmpdir(), "harness-install-k-"));
  writeFileSync(
    join(kernel, "package.json"),
    `${JSON.stringify({ name: "harness-kernel", private: true, dependencies: {} })}\n`,
  );
  const cap = capture();
  const code = await installPlugin(cap.streams, kernel, source, async () => {
    const dir = join(kernel, "node_modules", "@scope", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), readFileSync(join(source, "package.json")));
    writeFileSync(join(dir, "plugin.json"), readFileSync(join(source, "plugin.json")));
    return 0;
  });
  expect({ code, npmName: installedNpmName(source), stdout: cap.text().stdout }).toEqual({
    code: 0,
    npmName: "@scope/demo",
    stdout: "enabled plugin `demo` from `@scope/demo`\n",
  });
});

it("packageNameOf drops a version and keeps a scope", () => {
  expect(packageNameOf("@inhuman.tools/plugin-goal@0.0.1")).toBe("@inhuman.tools/plugin-goal");
  expect(packageNameOf("plugin-goal@latest")).toBe("plugin-goal");
  expect(packageNameOf("./plugins/inhuman-plugin-goal")).toBe("./plugins/inhuman-plugin-goal");
});

it("streams npm into the kernel and records the plugin.json name", async () => {
  const kernel = kernelWith("@inhuman.tools/plugin-goal", "goal");
  writeFileSync(
    join(kernel, "config.json"),
    `${JSON.stringify({ connections: {}, plugins: { goal: { enabled: false, guards: ["h1"] } } }, null, 2)}\n`,
  );
  const cap = capture();
  const seen: string[] = [];
  const npm: InstallNpm = async (options) => {
    seen.push(`${options.kernel} ${options.pkg}`);
    options.stdout.write("added 1 package\n");
    return 0;
  };
  const code = await installPlugin(cap.streams, kernel, "@inhuman.tools/plugin-goal@0.0.1", npm);
  const config = JSON.parse(readFileSync(join(kernel, "config.json"), "utf8")) as {
    connections: unknown;
    plugins: { goal: { enabled?: boolean; guards: string[] } };
  };
  expect({ code, seen, stdout: cap.text().stdout, config }).toEqual({
    code: 0,
    seen: [`${kernel} @inhuman.tools/plugin-goal@0.0.1`],
    stdout: "added 1 package\nenabled plugin `goal` from `@inhuman.tools/plugin-goal`\n",
    config: { connections: {}, plugins: { goal: { guards: ["h1"] } } },
  });
});

it("enables a plugin whose exports map does not expose plugin.json", async () => {
  const npmName = "@inhuman.tools/plugin-offload-tingle";
  const kernel = kernelWith(npmName, "offload-tingle", { exports: { ".": "./dist/plugin.js" } });
  writeFileSync(
    join(kernel, "config.json"),
    `${JSON.stringify({ plugins: { "offload-tingle": { enabled: false, guards: ["h1"] } } }, null, 2)}\n`,
  );
  const cap = capture();
  const code = await installPlugin(cap.streams, kernel, npmName, async (options) => {
    options.stdout.write("added 1 package\n");
    return 0;
  });
  const config = JSON.parse(readFileSync(join(kernel, "config.json"), "utf8")) as {
    plugins: { "offload-tingle": { enabled?: boolean; guards: string[] } };
  };
  expect({ code, stdout: cap.text().stdout, config }).toEqual({
    code: 0,
    stdout: "added 1 package\nenabled plugin `offload-tingle` from `@inhuman.tools/plugin-offload-tingle`\n",
    config: { plugins: { "offload-tingle": { guards: ["h1"] } } },
  });
});

it("does not write config when npm fails", async () => {
  const kernel = mkdtempSync(join(tmpdir(), "harness-install-fail-"));
  const cap = capture();
  const code = await installPlugin(cap.streams, kernel, "missing", async (options) => {
    options.stderr.write("404\n");
    return 1;
  });
  expect({
    code,
    stderr: cap.text().stderr,
    pkg: readFileSync(join(kernel, "package.json"), "utf8").includes("harness-kernel"),
  }).toEqual({
    code: 1,
    stderr: "404\n",
    pkg: true,
  });
  expect(() => readFileSync(join(kernel, "config.json"), "utf8")).toThrow();
});
