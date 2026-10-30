import { type AnyContractRouter, type ContractProcedure, isContractProcedure, oc } from "@orpc/contract";
import { z } from "zod";

import * as authorization from "./schemas/authorization.js";
import * as connection from "./schemas/connection.js";
import { uiFormSchema, uiResolveInput } from "./schemas/rpc.js";
import * as shapes from "./schemas/shapes.js";

/**
 * Which daemon owns the method. A method a host does not own falls through
 * session, then project, then kernel, so a session socket can also call a
 * kernel method; a kernel socket cannot call a session method (-32601).
 * `any` is built into every host's request dispatch (`ui/resolve`).
 */
export type HarnessHost = "session" | "kernel" | "any";

/** Carried by every procedure. `method` is the JSON-RPC wire name. */
export interface HarnessMeta {
  readonly method: string;
  readonly host: HarnessHost;
  /** The method may answer `{form:"ui", pending, body}` instead of its result; the caller finishes it with `ui/resolve`. */
  readonly mayPark?: true;
}

/** A contract procedure of this protocol: zod in and out, wire identity in `meta`. */
export type HarnessProcedure<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = ContractProcedure<
  I,
  O,
  any,
  HarnessMeta
>;

interface Doc {
  readonly summary: string;
  readonly description?: string;
  readonly mayPark?: true;
}

/** The HTTP path a procedure is projected to in the OpenAPI document. */
export function httpPathOf(meta: HarnessMeta): `/${string}` {
  return meta.host === "any" ? `/${meta.method}` : `/${meta.host}/${meta.method}`;
}

function rpc(host: HarnessHost, method: string, doc: Doc) {
  const meta: HarnessMeta = doc.mayPark === true ? { method, host, mayPark: true } : { method, host };
  const namespace = method.includes("/") ? method.slice(0, method.indexOf("/")) : method;
  return oc.$meta<HarnessMeta>(meta).route({
    method: "POST",
    path: httpPathOf(meta),
    summary: doc.summary,
    ...(doc.description === undefined ? {} : { description: doc.description }),
    tags: [host === "any" ? "ui" : `${host}.${namespace}`],
  });
}

/** A parking method's output: its result, or the form to answer. */
const parks = <T extends z.ZodType>(result: T) => z.union([result, uiFormSchema]);

const session = {
  kv: {
    set: rpc("session", "kv/set", {
      summary: "Write a key in session, project or kernel scope",
      description:
        'Session `model` / `connection` also become the last-choice default (project + kernel) when `remember` is set. `/model` and `/connect` send "1"; a bare session write (subagent, `--model`, `--connection`) does not.',
    })
      .input(shapes.kvSetInput)
      .output(shapes.kvOutput),
    clear: rpc("session", "kv/clear", { summary: "Clear a key in session, project or kernel scope" })
      .input(shapes.kvClearInput)
      .output(shapes.kvOutput),
  },
  plugin: {
    method: rpc("session", "plugin/method", {
      summary: "Call a plugin's own state method",
      description:
        "A plugin command's call into that plugin's own state. `args` is a JSON object, since action params cross as strings. `field` names the argument the composer text (`input`) fills; an empty `input` then refuses. A failure is data (`ok: false`), not an RPC error.",
    })
      .input(shapes.pluginMethodInput)
      .output(shapes.pluginMethodOutput),
  },
  policy: {
    set: rpc("session", "policy/set", { summary: "Set the session's permission mode" })
      .input(shapes.policySetInput)
      .output(shapes.policySetOutput),
    explain: rpc("session", "policy/explain", {
      summary: "Explain what would happen to a call right now",
      description:
        "Runs the same floor, grant and resolution code as a real call, with no judge and no effect. Returns the tier (block, soft-deny, ask, allow), the classes that voted, which resolver licenses it in the session's mode and from which layer, and the outcome.",
    })
      .input(authorization.policyExplainInput)
      .output(authorization.policyExplainOutput),
    overlay: rpc("session", "policy/overlay", {
      summary: "Set or clear this session's authorization overlay",
      description:
        "A human decision for this session only. It may loosen what the user's config says, but never past the project layer. Refused for any caller that is not a human client.",
    })
      .input(authorization.policyOverlayInput)
      .output(authorization.policyOverlayOutput),
    configGet: rpc("session", "policy/config-get", {
      summary: "Read the authorization layers this session resolves against",
    })
      .input(authorization.policyConfigGetInput)
      .output(authorization.policyConfigGetOutput),
  },
  connect: {
    adopt: rpc("session", "connect/adopt", {
      summary: "Adopt a connection and make it this session's connection",
      description:
        "Delegates to the kernel's `connect/adopt`, then writes the new connection id into the session's `connection` key and warms it. May park for UI.",
      mayPark: true,
    })
      .input(shapes.connectAdoptInput)
      .output(shapes.sessionConnectAdoptOutput),
  },
  turn: {
    send: rpc("session", "turn", {
      summary: "Submit a prompt as a turn, a steer or a queued prompt",
      description:
        "Pictures (`visuals`) ride only on a fresh turn: standard base64, stored beside the session, and the model must accept images.",
    })
      .input(shapes.turnInput)
      .output(shapes.turnOutput),
    cancel: rpc("session", "turn/cancel", { summary: "Cancel a running turn by turn id or eval request id" })
      .input(shapes.turnCancelInput)
      .output(shapes.turnCancelOutput),
    visual: rpc("session", "turn/visual", { summary: "Read one picture seated on the session's head turn" })
      .input(shapes.turnVisualReadInput)
      .output(shapes.turnVisualReadOutput),
    rewind: rpc("session", "turn/rewind", { summary: "Rewind the session to before a turn" })
      .input(shapes.turnRewindInput)
      .output(shapes.turnRewindOutput),
    retry: rpc("session", "turn/retry", { summary: "Retry the last turn" })
      .input(shapes.turnRetryInput)
      .output(shapes.turnRetryOutput),
  },
  blob: {
    get: rpc("session", "blob/get", {
      summary: "Read one blob the session's document references, by content hash",
      description:
        "Large bodies (a file's prior text today) live in the kernel's blob bucket; the document keeps `{sha256, bytes, mime, head}`. `text/*` blobs return `text`, anything else `bytesBase64`. The hash a document names is the capability; there is no listing.",
    })
      .input(shapes.blobGetInput)
      .output(shapes.blobGetOutput),
    vacuum: rpc("session", "blob/vacuum", {
      summary: "Move the session's large stored text into the blob bucket",
      description:
        "A session written before large bodies left the document keeps a file's prior text and an isolated completion's prompt inline, and the stored image carries them forever. The vacuum moves every such body over the inline limit into the kernel's blob bucket, leaving the head and a reference, then rewrites the stored image as one snapshot. Completions still running are skipped. `dryRun` counts what would move and writes nothing. Reads stay whole: the wire projection and `blob/get` resolve the references.",
    })
      .input(shapes.blobVacuumInput)
      .output(shapes.blobVacuumOutput),
  },
  compact: rpc("session", "compact", { summary: "Compact the session's context, optionally around a focus" })
    .input(shapes.compactInput)
    .output(shapes.compactOutput),
  rename: rpc("session", "rename", { summary: "Set the session title" })
    .input(shapes.renameInput)
    .output(shapes.renameOutput),
  eval: rpc("session", "eval", {
    summary: "Admit a Scheme program as an unattended eval turn",
    description:
      "Idempotent per `requestId`: a repeat with the same input returns the admitted turn; a repeat with different input is refused. `ok: false` with `policy_unavailable` means the requested permission policy cannot run unattended.",
  })
    .input(shapes.evalInput)
    .output(shapes.evalOutput),
  ask: {
    answer: rpc("session", "ask/answer", {
      summary: "Answer the live approval ask",
      description:
        "Answer the live ask or soft-deny on `sessionId`: this session, or a worker that escalated to it. `store` remembers a human yes to an ask as a grant (scope, subject, TTL); a soft-deny is never stored and a block is never put to a human.",
    })
      .input(authorization.askAnswerInput)
      .output(authorization.askAnswerOutput),
  },
  ack: {
    pending: rpc("session", "ack/pending", {
      summary: "List calls waiting for an acknowledgement",
      description:
        "A call that is allowed but flagged `needsAcknowledgement` waits for a person. Acks travel over RPC only: there is no ack job and no transcript entry. Absent `sessionId`: this session and the workers that escalated to it.",
    })
      .input(authorization.ackPendingInput)
      .output(authorization.ackPendingOutput),
    answer: rpc("session", "ack/answer", {
      summary: "Acknowledge or refuse a pending call, optionally remembering the acknowledgement",
      description:
        "Human clients only. `accept` lets the call run; a refusal is a human denial (its `comment` is what the agent reads). `store` remembers the acknowledgement at session, project, bot or global scope as one of the offered `storeOptions`; prompt-created project, bot and global acks last 7 days. A block and a policy denial are never put here. When the prompt was also an ask (a combined prompt), the same answer settles both.",
    })
      .input(authorization.ackAnswerInput)
      .output(authorization.ackAnswerOutput),
  },
  resident: {
    set: rpc("session", "resident/set", { summary: "Mark the session resident (kept alive) or not" })
      .input(shapes.residentSetInput)
      .output(shapes.residentSetOutput),
  },
  queue: {
    steerFirst: rpc("session", "queue/steer-first", {
      summary: "Promote the first queued prompt to a steer",
      description: "A queued row named by the id the client saw. Already drained or moved is `ok: false`.",
    })
      .input(shapes.queueRowInput)
      .output(shapes.queueRowOutput),
    retractLast: rpc("session", "queue/retract-last", {
      summary: "Retract the last queued prompt",
      description: "A queued row named by the id the client saw. Already drained or moved is `ok: false`.",
    })
      .input(shapes.queueRowInput)
      .output(shapes.queueRowOutput),
  },
  agentCalls: {
    list: rpc("session", "agent-calls/list", { summary: "List agent calls made from this session" })
      .input(shapes.agentCallsListInput)
      .output(shapes.agentCallsListOutput),
    inspect: rpc("session", "agent-calls/inspect", { summary: "Inspect one agent call by request id" })
      .input(shapes.agentCallsInspectInput)
      .output(shapes.agentCallsInspectOutput),
    cancel: rpc("session", "agent-calls/cancel", { summary: "Cancel one agent call by request id" })
      .input(shapes.agentCallsCancelInput)
      .output(shapes.agentCallsCancelOutput),
  },
};

const kernel = {
  termContinue: {
    set: rpc("kernel", "term-continue/set", { summary: "Remember which session a terminal key continues" })
      .input(shapes.termContinueSetInput)
      .output(shapes.termContinueOutput),
    clear: rpc("kernel", "term-continue/clear", { summary: "Forget a terminal key's continue session" })
      .input(shapes.termContinueClearInput)
      .output(shapes.termContinueOutput),
  },
  connect: {
    drop: rpc("kernel", "connect/drop", {
      summary: "Remove a connection and its secrets",
      description: "Without `confirm: true` it parks on a confirmation form; cancelling answers `{ok: false}`.",
      mayPark: true,
    })
      .input(shapes.connectDropInput)
      .output(parks(shapes.connectDropOutput)),
    adopt: rpc("kernel", "connect/adopt", {
      summary: "Adopt a connection from a driver",
      description:
        "Runs the driver's adopt flow. The flow may need the human (sign-in, a pasted key) and then parks. Cancelling answers `{ok: false}`.",
      mayPark: true,
    })
      .input(shapes.connectAdoptInput)
      .output(parks(shapes.connectAdoptOutput)),
    list: rpc("kernel", "connect/list", { summary: "List connections, optionally by ability claim" })
      .input(connection.listConnectionsInput)
      .output(connection.listConnectionsOutput),
    models: rpc("kernel", "connect/models", { summary: "Probe the model catalog of one or all connections" })
      .input(connection.connectModelsInput)
      .output(connection.connectModelsOutput),
    get: rpc("kernel", "connect/get", { summary: "Read one connection with its settings" })
      .input(connection.getConnectionInput)
      .output(connection.getConnectionOutput),
    setEnabled: rpc("kernel", "connect/set-enabled", { summary: "Enable or disable a connection" })
      .input(connection.setEnabledInput)
      .output(connection.setEnabledOutput),
    alwaysAllow: rpc("kernel", "connect/always-allow", { summary: "Always allow one tool of a connection" })
      .input(connection.persistToolInput)
      .output(connection.persistToolOutput),
    excludeTool: rpc("kernel", "connect/exclude-tool", { summary: "Exclude one tool of a connection" })
      .input(connection.persistToolInput)
      .output(connection.persistToolOutput),
    login: rpc("kernel", "connect/login", {
      summary: "Sign in to a connection",
      description: "May open a browser flow and park until the human finishes it.",
      mayPark: true,
    })
      .input(connection.loginInput)
      .output(parks(connection.loginOutput)),
    logout: rpc("kernel", "connect/logout", { summary: "Sign out of a connection" })
      .input(connection.logoutInput)
      .output(connection.logoutOutput),
    update: rpc("kernel", "connect/update", {
      summary: "Rename a connection or merge its settings",
      description: "Rename or merge settings of a connection that already exists. The id stays.",
    })
      .input(shapes.connectUpdateInput)
      .output(shapes.connectUpdateOutput),
  },
  mcpServer: {
    adopt: rpc("kernel", "mcp-server/adopt", {
      summary: "Adopt an MCP server as a connection",
      description: "May need the human (sign-in) and then parks.",
      mayPark: true,
    })
      .input(shapes.mcpServerAdoptInput)
      .output(parks(shapes.mcpServerAdoptOutput)),
    search: rpc("kernel", "mcp-server/search", { summary: "Search the official MCP registry" })
      .input(shapes.mcpServerSearchInput)
      .output(shapes.mcpServerSearchOutput),
  },
  config: {
    set: rpc("kernel", "config/set", { summary: "Set kernel configuration fields" })
      .input(shapes.configSetInput)
      .output(shapes.configSetOutput),
  },
  grant: {
    list: rpc("kernel", "grant/list", { summary: "List stored grants" })
      .input(authorization.grantListInput)
      .output(authorization.grantListOutput),
    add: rpc("kernel", "grant/add", {
      summary: "Store a grant from settings",
      description:
        "A grant turns an ask into allow for a family (a command, a path, an MCP server+tool+account). It never lifts a soft-deny or a block. Settings grants do not expire unless `ttlMs` is given.",
    })
      .input(authorization.grantAddInput)
      .output(authorization.grantAddOutput),
    revoke: rpc("kernel", "grant/revoke", { summary: "Revoke a stored grant" })
      .input(authorization.grantRevokeInput)
      .output(authorization.grantRevokeOutput),
  },
  ack: {
    list: rpc("kernel", "ack/list", {
      summary: "List stored acknowledgements",
      description:
        "The acknowledgements a person stored at session, project, bot or global scope (same rows, TTL and scopes as grants). Flags themselves live in the `authorization` block (see `policy/config-get`).",
    })
      .input(authorization.ackListInput)
      .output(authorization.ackListOutput),
    add: rpc("kernel", "ack/add", {
      summary: "Store an acknowledgement from settings",
      description:
        'Equivalent to "you can send any email you want in this project". Settings acknowledgements do not expire unless `ttlMs` is given.',
    })
      .input(authorization.ackAddInput)
      .output(authorization.ackAddOutput),
    revoke: rpc("kernel", "ack/revoke", { summary: "Revoke a stored acknowledgement" })
      .input(authorization.ackRevokeInput)
      .output(authorization.ackRevokeOutput),
  },
  plugin: {
    set: rpc("kernel", "plugin/set", { summary: "Enable, disable or foreground a plugin" })
      .input(shapes.pluginSetInput)
      .output(shapes.pluginSetOutput),
    install: rpc("kernel", "plugin/install", { summary: "Install a plugin from an npm spec" })
      .input(shapes.pluginInstallInput)
      .output(shapes.pluginInstallOutput),
    remove: rpc("kernel", "plugin/remove", { summary: "Remove an installed plugin" })
      .input(shapes.pluginRemoveInput)
      .output(shapes.pluginRemoveOutput),
  },
  skill: {
    list: rpc("kernel", "skill/list", { summary: "List skill files for a project and home" })
      .input(shapes.skillListInput)
      .output(shapes.skillListOutput),
    write: rpc("kernel", "skill/write", { summary: "Write a skill file" })
      .input(shapes.skillWriteInput)
      .output(shapes.skillWriteOutput),
    remove: rpc("kernel", "skill/remove", { summary: "Remove a skill file" })
      .input(shapes.skillRemoveInput)
      .output(shapes.skillRemoveOutput),
    read: rpc("kernel", "skill/read", { summary: "Read a skill file with its body" })
      .input(shapes.skillReadInput)
      .output(shapes.skillReadOutput),
  },
  remote: {
    login: rpc("kernel", "remote/login", {
      summary: "Sign in for remote access",
      description:
        "WorkOS device login. Parks on an open-url form until the human approves in the browser; cancelling answers `{ok: false}`. Fails when `HARNESS_REMOTE_WORKOS_CLIENT_ID` is unset.",
      mayPark: true,
    })
      .input(shapes.remoteLoginInput)
      .output(parks(shapes.remoteLoginOutput)),
    status: rpc("kernel", "remote/status", { summary: "Remote access state of this machine" })
      .input(shapes.remoteStatusInput)
      .output(shapes.remoteStatusOutput),
    logout: rpc("kernel", "remote/logout", {
      summary: "Drop remote access tokens",
      description: "Keeps the machine id, so signing in again reuses the same machine.",
    })
      .input(shapes.remoteLogoutInput)
      .output(shapes.remoteLogoutOutput),
  },
  bot: {
    write: rpc("kernel", "bot/write", {
      summary: "Write a bot definition",
      description:
        "Absent `invokes`, `reasoningEffort` and `modelPreferences` keep the file's current value; an empty list clears. Absent `mcp` keeps the file's grants; an empty list clears them. A settings save that does not know these fields must not wipe them.",
    })
      .input(shapes.botWriteInput)
      .output(shapes.botWriteOutput),
    remove: rpc("kernel", "bot/remove", { summary: "Remove a bot definition" })
      .input(shapes.botRemoveInput)
      .output(shapes.botRemoveOutput),
  },
};

const common = {
  resolve: rpc("any", "ui/resolve", {
    summary: "Answer a parked UI form",
    description:
      'Finishes a call that answered `{form: "ui", pending, body}`. The reply is the resumed call\'s result, or another park form. `kind: "cancel"` aborts the parked call. Closing the socket cancels every park it owns.',
  })
    .input(uiResolveInput)
    .output(z.record(z.string(), z.unknown())),
};

/**
 * The daemon's RPC contract, grouped by host and namespace. The tree is for
 * callers; the JSON-RPC wire name of each procedure is `meta.method`.
 * `turn` is `session.turn.send`: the namespace and the bare method share a name.
 */
export const contract = { session, kernel, ui: common };
export type HarnessContract = typeof contract;

export interface ContractEntry {
  /** Tree path, e.g. `["session", "kv", "set"]`. */
  readonly path: readonly string[];
  readonly procedure: HarnessProcedure;
  readonly meta: HarnessMeta;
}

/** Every procedure of a router with its tree path, in declaration order. */
export function listProcedures(router: AnyContractRouter = contract, path: readonly string[] = []): ContractEntry[] {
  if (isContractProcedure(router)) {
    return [{ path, procedure: router as HarnessProcedure, meta: router["~orpc"].meta as HarnessMeta }];
  }
  return Object.entries(router).flatMap(([key, child]) => listProcedures(child, [...path, key]));
}

/** The wire name of a procedure. */
export function methodOf(procedure: HarnessProcedure): string {
  return procedure["~orpc"].meta.method;
}

/** Wire name for a tree path (`["session","kv","set"]` is `kv/set`), or `undefined` for an unknown path. */
export function methodForPath(path: readonly string[]): string | undefined {
  let node: unknown = contract;
  for (const key of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return isContractProcedure(node) ? (node["~orpc"].meta as HarnessMeta).method : undefined;
}
