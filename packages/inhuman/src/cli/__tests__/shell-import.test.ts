/**
 * The TUI and the web app are optional peers, loaded by dynamic import. A missing shell is a one-line hint
 * and exit 1; a broken install of a shell that is there keeps its stack.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ShellContext, type Streams } from "../context.js";
import { importShell, isShellMissing } from "../shell-import.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  let stderr = "";
  const streams: Streams = {
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as NodeJS.ReadStream,
    stdout: new Writable({ write: (_chunk, _enc, cb) => cb() }) as NodeJS.WriteStream,
    stderr: new Writable({
      write(chunk, _enc, cb) {
        stderr += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
  };
  return {
    context: new ShellContext(streams),
    get stderr() {
      return stderr;
    },
  };
}

/** What a real `import()` of `specifier` throws, as seen from a Node process in `cwd`. */
function importFailure(specifier: string, cwd: string): Error {
  const script = `try { await import(${JSON.stringify(specifier)}); } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8" });
  const { code, message } = JSON.parse(out) as { code: string; message: string };
  return Object.assign(new Error(message), { code });
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-shell-import-"));
  temps.push(dir);
  return dir;
}

describe("isShellMissing", () => {
  it("matches the error Node raises for a package that is not installed, subpath or not", () => {
    const cwd = scratch();
    const tui = "@inhuman.tools/harness-ghost-tui";
    const web = "@inhuman.tools/harness-ghost-web/server";
    expect({
      tui: isShellMissing(importFailure(tui, cwd), tui),
      web: isShellMissing(importFailure(web, cwd), web),
    }).toEqual({ tui: true, web: true });
  });

  it("does not match a shell that is installed but cannot load", () => {
    const cwd = scratch();
    const shell = join(cwd, "node_modules", "ghost-shell");
    mkdirSync(shell, { recursive: true });
    writeFileSync(
      join(shell, "package.json"),
      JSON.stringify({ name: "ghost-shell", type: "module", main: "index.js" }),
    );
    writeFileSync(join(shell, "index.js"), 'import "ghost-shell-dependency";\n');
    const brokenDependency = importFailure("ghost-shell", cwd);
    const missingFile = importFailure("./nothing-here.mjs", cwd);
    expect({
      dependencyCode: (brokenDependency as NodeJS.ErrnoException).code,
      dependency: isShellMissing(brokenDependency, "ghost-shell"),
      file: isShellMissing(missingFile, "ghost-shell"),
    }).toEqual({ dependencyCode: "ERR_MODULE_NOT_FOUND", dependency: false, file: false });
  });

  it("matches only module-not-found errors", () => {
    const named = "Cannot find package '@inhuman.tools/harness-tui' imported from /somewhere/tui-command.js";
    const spec = "@inhuman.tools/harness-tui";
    expect({
      notFound: isShellMissing(Object.assign(new Error(named), { code: "ERR_MODULE_NOT_FOUND" }), spec),
      cjs: isShellMissing(Object.assign(new Error(named), { code: "MODULE_NOT_FOUND" }), spec),
      otherCode: isShellMissing(Object.assign(new Error(named), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }), spec),
      noCode: isShellMissing(new Error(named), spec),
      notAnError: isShellMissing(named, spec),
    }).toEqual({ notFound: true, cjs: true, otherCode: false, noCode: false, notAnError: false });
  });
});

describe("importShell", () => {
  it("returns the loaded module and writes nothing", async () => {
    const out = capture();
    const loaded = await importShell(out.context, { label: "TUI shell", specifier: "@inhuman.tools/harness-tui" }, () =>
      Promise.resolve({ attachTui: 1 }),
    );
    expect({ loaded, stderr: out.stderr }).toEqual({ loaded: { attachTui: 1 }, stderr: "" });
  });

  it("names the package to install, once, for a shell that is not there", async () => {
    const out = capture();
    const cwd = scratch();
    const tui = { label: "TUI shell", specifier: "@inhuman.tools/harness-ghost-tui" };
    const web = { label: "web shell", specifier: "@inhuman.tools/harness-ghost-web/server" };
    const fail = (specifier: string) => () => Promise.reject(importFailure(specifier, cwd));
    const results = [
      await importShell(out.context, tui, fail(tui.specifier)),
      await importShell(out.context, web, fail(web.specifier)),
    ];
    expect({ results, stderr: out.stderr }).toEqual({
      results: [undefined, undefined],
      stderr:
        "inhuman: the TUI shell is not installed — add @inhuman.tools/harness-ghost-tui\n" +
        "inhuman: the web shell is not installed — add @inhuman.tools/harness-ghost-web\n",
    });
  });

  it("lets every other failure through unchanged", async () => {
    const out = capture();
    const broken = Object.assign(
      new Error("Cannot find package 'quickdraw' imported from /x/harness-tui/dist/index.js"),
      {
        code: "ERR_MODULE_NOT_FOUND",
      },
    );
    const thrown = await importShell(out.context, { label: "TUI shell", specifier: "@inhuman.tools/harness-tui" }, () =>
      Promise.reject(broken),
    ).catch((error: unknown) => error);
    expect({ same: thrown === broken, stderr: out.stderr }).toEqual({ same: true, stderr: "" });
  });
});

describe("shells stay optional", () => {
  it("no production file imports a shell statically", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter(
        (file) =>
          file.endsWith(".ts") && !/(?:^|\/)(?:__tests__|__process__)\//.test(file) && !file.endsWith(".test.ts"),
      )
      .toSorted();
    const staticShellImport =
      /^(?:import|export)\s(?!type\b)[^"']*?from\s*["']@inhuman\.tools\/harness-(?:tui|web-app)/m;
    expect({
      scanned: files.length > 0,
      offenders: files.filter((file) => staticShellImport.test(readFileSync(join(root, file), "utf8"))),
    }).toEqual({ scanned: true, offenders: [] });
  });
});
