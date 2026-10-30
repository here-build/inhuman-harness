/**
 * Kernel-plane writer over ConnectionSpec. No session, no TUI.
 */
import { createInterface } from "node:readline";

import { isUiForm, type UiAnswer, type UiForm } from "@inhuman.tools/harness-contract";
import { type KernelRpc, openExternalUrl } from "@inhuman.tools/harness-sdk";

import { type ShellContext, type Streams } from "./context.js";
import { openKernelRpc } from "./kernel-client.js";

export type McpVerb = "add" | "list" | "get" | "remove" | "login" | "logout" | "enable" | "disable";

export type McpArgv = {
  readonly kernel: string;
  readonly mcpVerb: McpVerb;
  readonly name?: string;
  readonly url?: string;
  readonly tokenEnv?: string;
  readonly login?: boolean;
  readonly json?: boolean;
  readonly browser?: boolean;
  readonly noBrowser?: boolean;
  readonly "--"?: ReadonlyArray<string | number>;
};

export type McpDeps = {
  readonly rpc?: KernelRpc;
  readonly env?: NodeJS.ProcessEnv;
  readonly openBrowser?: (url: string) => void;
  readonly readLine?: (stdin: NodeJS.ReadStream) => Promise<string>;
};

export async function runMcp(args: McpArgv, streams: ShellContext, deps: McpDeps = {}): Promise<{ code: number }> {
  try {
    switch (args.mcpVerb) {
      case "add":
        return await runAdd(args, streams, deps);
      case "list":
        return await withRpc(args, deps, (rpc) => runList(rpc, streams, args.json === true));
      case "get":
        return await withRpc(args, deps, (rpc) => runGet(rpc, streams, requireName(args), args.json === true));
      case "remove":
        return await withRpc(args, deps, (rpc) => runRemove(rpc, requireName(args)));
      case "login":
        return await withRpc(args, deps, (rpc) => runLogin(rpc, streams, requireName(args), args, deps));
      case "logout":
        return await withRpc(args, deps, (rpc) =>
          rpc.request("connect/logout", { id: requireName(args) }).then(() => ({ code: 0 })),
        );
      case "enable":
        return await withRpc(args, deps, (rpc) =>
          rpc.request("connect/set-enabled", { id: requireName(args), enabled: true }).then(() => ({ code: 0 })),
        );
      case "disable":
        return await withRpc(args, deps, (rpc) =>
          rpc.request("connect/set-enabled", { id: requireName(args), enabled: false }).then(() => ({ code: 0 })),
        );
    }
  } catch (error) {
    streams.writeErr(error);
    return { code: error instanceof UsageError ? 2 : 1 };
  }
}

function requireName(args: McpArgv): string {
  const name = args.name?.trim() ?? "";
  if (name === "") throw new UsageError("name is required");
  return name;
}

class UsageError extends Error {
  readonly name = "UsageError";
}

async function runAdd(args: McpArgv, streams: ShellContext, deps: McpDeps): Promise<{ code: number }> {
  const name = requireName(args);
  const url = args.url?.trim() ?? "";
  const rest = (args["--"] ?? []).map(String);
  if (url !== "" && rest.length > 0) {
    streams.writeErr("use --url or -- <command>, not both");
    return { code: 2 };
  }
  if (url === "" && rest.length === 0) {
    streams.writeErr("add requires --url or -- <command>");
    return { code: 2 };
  }
  if (args.login === true && url === "") {
    streams.writeErr("login is only valid with --url");
    return { code: 2 };
  }
  if (args.login === true && streams.stdin.isTTY !== true) {
    streams.writeErr("login requires a TTY");
    return { code: 2 };
  }
  const tokenEnv = args.tokenEnv?.trim() ?? "";
  if (tokenEnv !== "" && url === "") {
    streams.writeErr("token-env is only valid with --url");
    return { code: 2 };
  }

  let adopt: Record<string, unknown>;
  if (url === "") {
    const command = rest[0]?.trim() ?? "";
    if (command === "") {
      streams.writeErr("add requires --url or -- <command>");
      return { code: 2 };
    }
    adopt = { driver: "mcp-stdio", name, settings: { command, args: rest.slice(1) } };
  } else {
    const settings: Record<string, unknown> = { url };
    adopt = { driver: "mcp-http", name, settings };
    if (tokenEnv !== "") {
      const env = deps.env ?? process.env;
      const token = env[tokenEnv];
      if (token === undefined || token === "") {
        streams.writeErr(`${tokenEnv} is not set`);
        return { code: 2 };
      }
      adopt.secrets = { token };
    }
  }

  return await withRpc(args, deps, async (rpc) => {
    const adopted = await rpc.request("connect/adopt", adopt);
    const id = adoptedId(adopted);
    if (id === undefined) {
      streams.writeErr("adopt did not return an id");
      return { code: 1 };
    }
    streams.stdout.write(`${id}\n`);
    if (args.login === true) {
      const login = await runLogin(rpc, streams, id, args, deps);
      if (login.code !== 0) return login;
    }
    return { code: 0 };
  });
}

async function runList(rpc: KernelRpc, streams: Streams, json: boolean): Promise<{ code: number }> {
  const payload = await rpc.request("connect/list", { can: "mcp" });
  if (json) {
    streams.stdout.write(`${JSON.stringify(payload)}\n`);
    return { code: 0 };
  }
  for (const row of asRows(payload)) {
    streams.stdout.write(`${formatRow(row)}\n`);
  }
  return { code: 0 };
}

async function runGet(rpc: KernelRpc, streams: ShellContext, id: string, json: boolean): Promise<{ code: number }> {
  let payload: unknown;
  try {
    payload = await rpc.request("connect/get", { id });
  } catch (error) {
    streams.writeErr(error);
    return { code: 1 };
  }
  if (payload == null) {
    streams.writeErr(`${id} not found`);
    return { code: 1 };
  }
  if (json) {
    streams.stdout.write(`${JSON.stringify(payload)}\n`);
    return { code: 0 };
  }
  streams.stdout.write(`${formatRow(asConnection(payload, id))}\n`);
  return { code: 0 };
}

async function runRemove(rpc: KernelRpc, id: string): Promise<{ code: number }> {
  // CONFIRM_AHEAD: KernelDaemon parks harness/confirm unless confirm:true.
  await rpc.request("connect/drop", { id, confirm: true });
  return { code: 0 };
}

async function runLogin(
  rpc: KernelRpc,
  streams: Streams,
  id: string,
  args: McpArgv,
  deps: McpDeps,
): Promise<{ code: number }> {
  const noBrowser = args.noBrowser === true || args.browser === false;
  let result: unknown = await rpc.request("connect/login", { id });
  while (isUiForm(result)) {
    const answer = await handleUi(result, streams, {
      noBrowser,
      openBrowser: deps.openBrowser ?? openExternalUrl,
      readLine: deps.readLine ?? readStdinLine,
    });
    result = await rpc.request("ui/resolve", { pending: result.pending, ...answer });
  }
  return { code: 0 };
}

type UiHandle = {
  readonly noBrowser: boolean;
  readonly openBrowser: (url: string) => void;
  readonly readLine: (stdin: NodeJS.ReadStream) => Promise<string>;
};

async function handleUi(form: UiForm, streams: Streams, opts: UiHandle): Promise<UiAnswer> {
  const authorizeUrl = form.body.match(/https?:\/\/[^\s"'<>\\]+/i)?.[0];
  if (authorizeUrl !== undefined) {
    return await handleOAuth(authorizeUrl, streams, opts);
  }
  if (form.body.includes("harness/confirm")) {
    return { kind: "accept" };
  }
  throw new Error("unsupported ui park");
}

/** The daemon holds the loopback; this client opens the URL, or hands back what the user pasted. */
async function handleOAuth(authorizeUrl: string, streams: Streams, opts: UiHandle): Promise<UiAnswer> {
  streams.stderr.write(`${authorizeUrl}\n`);
  if (opts.noBrowser) {
    streams.stderr.write("Paste the full redirect URL:\n");
    const line = (await opts.readLine(streams.stdin)).trim();
    if (line === "") throw new Error("redirect URL is empty");
    return { kind: "text", input: line };
  }
  opts.openBrowser(authorizeUrl);
  return { kind: "opened", url: authorizeUrl };
}

async function withRpc(
  args: McpArgv,
  deps: McpDeps,
  run: (rpc: KernelRpc) => Promise<{ code: number }>,
): Promise<{ code: number }> {
  const owned = deps.rpc === undefined;
  const rpc = deps.rpc ?? (await openKernelRpc(args.kernel));
  try {
    return await run(rpc);
  } finally {
    if (owned) await rpc[Symbol.asyncDispose]();
  }
}

function adoptedId(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const id = (result as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

function asRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object" && payload !== null) {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.connections)) return rec.connections;
    if (Array.isArray(rec.items)) return rec.items;
  }
  return [];
}

function asConnection(payload: unknown, id: string): unknown {
  if (typeof payload === "object" && payload !== null) {
    const rec = payload as Record<string, unknown>;
    if (rec.connection !== undefined) return rec.connection;
    if (rec.id !== undefined || rec.name !== undefined) return payload;
  }
  return { id };
}

function formatRow(row: unknown): string {
  const rec = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
  const id = stringOf(rec.id) || stringOf(rec.name);
  const status = stringOf(rec.status) || stringOf(rec.readyState) || (rec.issue === "failed" ? "failed" : "");
  const driver = driverName(rec.driver);
  const tools = toolCount(rec);
  const error = stringOf(rec.error);
  const cols = [id, status, driver, `tools:${tools}`];
  if (error !== "") cols.push(error);
  return cols.join("  ");
}

function driverName(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "name" in value) {
    return stringOf((value as { name?: unknown }).name);
  }
  return "";
}

function toolCount(rec: Record<string, unknown>): number {
  if (Array.isArray(rec.tools)) return rec.tools.length;
  if (typeof rec.tools === "number" && Number.isFinite(rec.tools)) return rec.tools;
  if (typeof rec.toolCount === "number" && Number.isFinite(rec.toolCount)) return rec.toolCount;
  return 0;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readStdinLine(stdin: NodeJS.ReadStream): Promise<string> {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return line.trim();
    }
    throw new Error("stdin closed");
  } finally {
    rl.close();
  }
}
