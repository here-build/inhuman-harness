/**
 * Clipanion routing: default TUI, local flags, `--` remainder, usage → 2.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { expect, it } from "vitest";

import { run } from "../../bin.js";
import { ShellContext, type Streams } from "../context.js";
import { isEvalArgv, makeCli } from "../register.js";

function commandField(cmd: object, key: string): unknown {
  return Reflect.get(cmd, key);
}

function capture() {
  let stdout = "";
  let stderr = "";
  const streams: Streams = {
    stdin: Object.assign(new Readable({ read() {} }), { isTTY: false }) as NodeJS.ReadStream,
    stdout: new Writable({
      write(chunk, _enc, cb) {
        stdout += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
    stderr: new Writable({
      write(chunk, _enc, cb) {
        stderr += String(chunk);
        cb();
      },
    }) as NodeJS.WriteStream,
  };
  return {
    streams,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

it("routes commands and scopes flags", () => {
  const cli = makeCli();
  const ctx = new ShellContext(capture().streams);
  const routes = [
    { argv: ["--session", "s1"], className: "TuiCommand", session: "s1" },
    { argv: ["--model", "grok-4"], className: "TuiCommand", model: "grok-4" },
    {
      argv: ["--connection", "grok", "--model", "grok-4"],
      className: "TuiCommand",
      connection: "grok",
      model: "grok-4",
    },
    { argv: ["mcp", "list", "--json"], className: "McpListCommand", json: true },
    {
      argv: ["mcp", "add", "airtable", "--", "npx", "-y", "airtable-mcp-server"],
      className: "McpAddCommand",
      name: "airtable",
      rest: ["npx", "-y", "airtable-mcp-server"],
    },
    { argv: ["mcp", "login", "sentry", "--no-browser"], className: "McpLoginCommand", browser: false },
    { argv: ["daemon", "stop"], className: "DaemonStopCommand" },
    { argv: ["start"], className: "StartCommand", port: "8787" },
    { argv: ["web"], className: "WebCommand", port: "8787" },
    { argv: ["web", "--port", "9"], className: "WebCommand", port: "9" },
    { argv: ["install", "@inhuman.tools/plugin-goal"], className: "InstallCommand", pkg: "@inhuman.tools/plugin-goal" },
    {
      argv: ["eval", "-e", "(+ 1 2)"],
      className: "EvalCommand",
      expression: "(+ 1 2)",
      mode: "auto",
      format: "scheme",
    },
    {
      argv: ["eval", "-e", "(+ 1 2)", "--model", "m1", "--connection", "c1"],
      className: "EvalCommand",
      model: "m1",
      connection: "c1",
    },
    {
      argv: ["eval", "-p", "hi", "--agent", "g", "--model", "m1"],
      className: "EvalCommand",
      prompt: "hi",
      agent: "g",
      model: "m1",
    },
    { argv: ["eval", "-e", "(+ 1 2)", "--mode", "always-approve"], className: "EvalCommand", mode: "yolo" },
    {
      argv: ["eval", "--kernel", "other.scm", "program.scm"],
      className: "EvalCommand",
      file: "program.scm",
      kernel: "other.scm",
    },
    {
      argv: ["eval", "program.scm", "-e", "(go)"],
      className: "EvalCommand",
      file: "program.scm",
      expression: "(go)",
    },
    { argv: ["--resume", "s1"], className: "TuiCommand", resume: "s1" },
    { argv: ["completion", "zsh"], className: "CompletionCommand", shell: "zsh" },
    { argv: ["complete", "auth"], className: "CompleteCommand", query: "auth" },
    { argv: ["--continue"], className: "TuiCommand", continueLast: true },
    { argv: ["mcp", "list", "--session", "s1"], threw: true },
    { argv: ["daemon", "start", "--restart-daemon"], threw: true },
    { argv: ["eval", "-e", "(+ 1 2)", "--mode", "manual"], threw: true },
    { argv: ["eval", "-e", "(+ 1 2)", "--format", "yaml"], threw: true },
    { argv: ["eval", "-e", "(+ 1 2)", "--width", "80"], threw: true },
  ];
  expect(
    routes.map((row) => {
      try {
        const cmd = cli.process(row.argv, ctx);
        return Object.fromEntries(
          Object.entries(row).map(([key, want]) => [
            key,
            key === "argv" ? want : key === "className" ? cmd.constructor.name : commandField(cmd, key),
          ]),
        );
      } catch {
        return { argv: row.argv, threw: true };
      }
    }),
  ).toEqual(routes);

  const evalArgv = [
    { argv: ["-e", "(+ 1 2)"], eval: true },
    { argv: ["program.scm"], eval: true },
    { argv: ["--kernel", "other.scm"], eval: false },
    { argv: ["--kernel", "other.scm", "program.scm"], eval: true },
    { argv: ["--session", "s1"], eval: false },
    { argv: ["--model", "grok-4"], eval: false },
    { argv: ["--model", "grok-4", "program.scm"], eval: true },
    { argv: ["--resume", "s1"], eval: false },
    { argv: ["mcp", "list"], eval: false },
    { argv: ["install", "pkg"], eval: false },
    { argv: ["--format", "json"], eval: true },
    { argv: ["--resume", "s1", "-e", "(+ 1 2)"], eval: true },
    { argv: ["complete"], eval: false },
    { argv: ["completion", "zsh"], eval: false },
    { argv: ["--continue"], eval: false },
    { argv: ["--continue", "-e", "(+ 1 2)"], eval: true },
  ];
  expect(evalArgv.map((row) => ({ argv: row.argv, eval: isEvalArgv(row.argv) }))).toEqual(evalArgv);
});

it("usage failures exit 2 on stderr", async () => {
  const rows = [
    { argv: ["mcp"], match: /Specify an mcp command/ },
    { argv: ["daemon"], match: /Specify a daemon command/ },
    { argv: ["mcp", "list", "--session", "s1"], match: /session|Unsupported option/i },
    { argv: ["mcp", "add"], match: /positional|Not enough/i },
    { argv: ["mcp", "login", "sentry", "--callback-port", "4242"], match: /callback-port|Unsupported option/i },
    { argv: ["-e", "(+ 1 2)", "--mode", "manual"], match: /Invalid value for --mode/ },
    { argv: ["-e", "(+ 1 2)", "--mode", "act"], match: /Invalid value for --mode/ },
    { argv: ["-e", "(+ 1 2)", "--format", "yaml"], match: /Invalid value for --format/ },
    { argv: ["-e", "(+ 1 2)", "--width", "80"], match: /width|Unsupported option/i },
    { argv: ["-e", "(+ 1 2)", "--resume", "s1"], match: /--resume|--session|--continue/ },
    { argv: ["-e", "(+ 1 2)", "--continue"], match: /--resume|--session|--continue/ },
    { argv: ["--continue", "--resume", "s1"], match: /--continue/ },
    { argv: ["-e", "(+ 1 2)", "-p", "hi", "--agent", "g"], match: /cannot combine|-p/ },
    { argv: ["program.scm", "-p", "hi", "--agent", "g"], match: /cannot combine|-p/ },
    { argv: ["--format", "json"], match: /eval requires/ },
    { argv: ["-p", "hi"], match: /--agent/ },
    { argv: ["mcp", "add", "airtable", "--model", "grok-4"], match: /does not select a model/ },
    { argv: ["daemon", "start", "--connection", "grok"], match: /does not select a model/ },
    { argv: ["install"], match: /Not enough|package/i },
    { argv: ["install", "pkg", "--model", "grok-4"], match: /does not select a model/ },
  ];
  const observed = [];
  for (const row of rows) {
    const cap = capture();
    const result = await run(row.argv, cap.streams);
    observed.push({ argv: row.argv, code: result.code, stderr: cap.stderr });
  }
  expect(observed).toEqual(
    rows.map((row) => ({
      argv: row.argv,
      code: 2,
      stderr: expect.stringMatching(row.match),
    })),
  );
});

it("usage and missing files do not create a session", async () => {
  const kernel = join(tmpdir(), `harness-eval-usage-${Date.now()}`);
  const cap = capture();
  const result = await run(["-e", "(+ 1 2)", "--mode", "manual", "--kernel", kernel], cap.streams);
  const missing = capture();
  const gone = await run(["eval", join(kernel, "nope.scm")], missing.streams);
  expect({
    usage: { code: result.code, dir: existsSync(kernel) },
    missing: { code: gone.code, stderr: missing.stderr, dir: existsSync(kernel) },
  }).toEqual({
    usage: { code: 2, dir: false },
    missing: { code: 1, stderr: expect.stringMatching(/ENOENT|no such file|nope\.scm/i), dir: false },
  });
});

it("complete without a daemon is empty; completion zsh prints a hook", async () => {
  const kernel = join(tmpdir(), `harness-complete-miss-${Date.now()}`);
  const completeCap = capture();
  const complete = await run(["complete", "--kernel", kernel], completeCap.streams);
  const zshCap = capture();
  const zsh = await run(["completion", "zsh"], zshCap.streams);
  expect({
    complete: { code: complete.code, stdout: completeCap.stdout, dir: existsSync(kernel) },
    zsh: { code: zsh.code, stdout: zshCap.stdout },
  }).toEqual({
    complete: { code: 0, stdout: "", dir: false },
    zsh: { code: 0, stdout: expect.stringMatching(/#compdef inhuman[\s\S]*inhuman complete/) },
  });
});
