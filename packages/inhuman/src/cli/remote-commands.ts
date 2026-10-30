/**
 * `inhuman login | logout | remote status`: remote access through the relay.
 * The daemon does the work (`remote/login`, `remote/logout`, `remote/status`); this renders the parked
 * open-url form and the status. The daemon reads HARNESS_REMOTE_URL (and the optional
 * HARNESS_REMOTE_WORKOS_CLIENT_ID override) from its own environment, inherited from the process that spawned it.
 */
import { isUiForm } from "@inhuman.tools/harness-contract";
import { type KernelRpc, openExternalUrl } from "@inhuman.tools/harness-sdk";
import { Command, Option } from "clipanion";

import { KernelCommand, type ShellContext, type Streams } from "./context.js";
import { openKernelRpc } from "./kernel-client.js";

const ENV_HELP = `
      The daemon reads two optional variables from its own environment, so set them before it starts (run
      \`inhuman daemon restart\` if it is already running):

        HARNESS_REMOTE_URL               relay origin (default https://harness.inhuman.tools)
        HARNESS_REMOTE_WORKOS_CLIENT_ID  WorkOS client id (default: the one the relay publishes)
`;

export class LoginCommand extends KernelCommand {
  static paths = [["login"]];
  static usage = Command.Usage({
    category: "Remote",
    description: "sign this machine in for remote access",
    details: `
      Starts a WorkOS device login. Open the printed address, check the code, and approve. The daemon then keeps
      a connection to the relay open and this machine shows up on the remote picker.
      ${ENV_HELP}`,
    examples: [["Name the machine", "$0 login --name laptop"]],
  });

  name = Option.String("--name", { description: "machine name on the remote picker (default: hostname)" });
  browser = Option.Boolean("--browser", true, { description: "open the approval page in a browser" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman login");
    if (blocked !== undefined) return blocked;
    return (
      await runRemote(
        { verb: "login", kernel: this.kernelPath(), name: this.name, browser: this.browser },
        this.context,
      )
    ).code;
  }
}

export class LogoutCommand extends KernelCommand {
  static paths = [["logout"]];
  static usage = Command.Usage({
    category: "Remote",
    description: "drop this machine's remote access login",
  });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman logout");
    if (blocked !== undefined) return blocked;
    return (await runRemote({ verb: "logout", kernel: this.kernelPath() }, this.context)).code;
  }
}

export class RemoteCommand extends KernelCommand {
  static paths = [["remote"]];
  static usage = Command.Usage({
    category: "Remote",
    description: "remote access",
  });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman remote");
    if (blocked !== undefined) return blocked;
    this.context.stderr.write("Specify a remote command: status\n");
    return 2;
  }
}

export class RemoteStatusCommand extends KernelCommand {
  static paths = [["remote", "status"]];
  static usage = Command.Usage({
    category: "Remote",
    description: "show remote access state",
    details: ENV_HELP,
  });

  json = Option.Boolean("--json", false, { description: "print JSON" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman remote status");
    if (blocked !== undefined) return blocked;
    return (await runRemote({ verb: "status", kernel: this.kernelPath(), json: this.json }, this.context)).code;
  }
}

export type RemoteArgv =
  | { readonly verb: "login"; readonly kernel: string; readonly name?: string | undefined; readonly browser?: boolean }
  | { readonly verb: "logout"; readonly kernel: string }
  | { readonly verb: "status"; readonly kernel: string; readonly json?: boolean };

export type RemoteDeps = {
  readonly rpc?: KernelRpc;
  readonly openBrowser?: (url: string) => void;
};

export async function runRemote(
  args: RemoteArgv,
  streams: ShellContext,
  deps: RemoteDeps = {},
): Promise<{ code: number }> {
  const owned = deps.rpc === undefined;
  try {
    const rpc = deps.rpc ?? (await openKernelRpc(args.kernel));
    try {
      switch (args.verb) {
        case "login":
          return await runLogin(rpc, streams, args, deps);
        case "logout":
          return await runLogout(rpc, streams);
        case "status":
          return await runStatus(rpc, streams, args.json === true);
      }
      // Unreachable: the verbs above are exhaustive.
      return { code: 2 };
    } finally {
      if (owned) await rpc[Symbol.asyncDispose]();
    }
  } catch (error) {
    streams.writeErr(error);
    return { code: 1 };
  }
}

type LoginReply = { ok: true; email: string; machineId: string } | { ok: false };

async function runLogin(
  rpc: KernelRpc,
  streams: ShellContext,
  args: Extract<RemoteArgv, { verb: "login" }>,
  deps: RemoteDeps,
): Promise<{ code: number }> {
  const open = deps.openBrowser ?? openExternalUrl;
  let result: unknown = await rpc.request("remote/login", args.name === undefined ? {} : { name: args.name });
  while (isUiForm(result)) {
    const url = result.body.match(/https?:\/\/[^\s"'<>\\]+/i)?.[0];
    if (url === undefined) throw new Error("remote/login: the daemon parked a form with no address");
    const code = userCode(url);
    streams.stderr.write(`Approve this machine for remote access:\n  ${url}\n`);
    if (code !== undefined) streams.stderr.write(`Check that the page shows the code ${code}.\n`);
    streams.stderr.write("Waiting for approval...\n");
    if (args.browser !== false) open(url);
    result = await rpc.request("ui/resolve", { pending: result.pending, kind: "opened", url });
  }
  const reply = result as LoginReply;
  if (reply.ok !== true) {
    streams.writeErr("login cancelled");
    return { code: 1 };
  }
  const who = reply.email === "" ? "signed in" : `signed in as ${reply.email}`;
  streams.stdout.write(`${who}; machine ${reply.machineId}\n`);
  return { code: 0 };
}

function userCode(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("user_code") ?? undefined;
  } catch {
    return undefined;
  }
}

async function runLogout(rpc: KernelRpc, streams: Streams): Promise<{ code: number }> {
  const reply = (await rpc.request("remote/logout", {})) as { wasLoggedIn?: boolean };
  streams.stdout.write(reply.wasLoggedIn === true ? "signed out of remote access\n" : "was not signed in\n");
  return { code: 0 };
}

type StatusReply = {
  loggedIn: boolean;
  email?: string;
  machineId: string;
  machineName: string;
  relayUrl: string;
  connected: boolean;
  lastError?: string;
};

async function runStatus(rpc: KernelRpc, streams: Streams, json: boolean): Promise<{ code: number }> {
  const status = (await rpc.request("remote/status", {})) as StatusReply;
  if (json) {
    streams.stdout.write(`${JSON.stringify(status)}\n`);
    return { code: 0 };
  }
  const rows: Array<[string, string]> = [
    [
      "remote access",
      status.loggedIn ? `signed in${status.email === undefined ? "" : ` as ${status.email}`}` : "signed out",
    ],
    ["machine", `${status.machineName} (${status.machineId})`],
    ["relay", status.relayUrl],
    ["connection", status.connected ? "connected" : status.loggedIn ? "not connected (retrying)" : "off"],
    ...(status.lastError === undefined ? [] : ([["last error", status.lastError]] as Array<[string, string]>)),
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  streams.stdout.write(`${rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n")}\n`);
  if (!status.loggedIn) streams.stdout.write("run `inhuman login` to sign in\n");
  return { code: 0 };
}
