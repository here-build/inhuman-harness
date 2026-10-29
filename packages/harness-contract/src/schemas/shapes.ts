import { z } from "zod";

import { uiFormSchema } from "./rpc.js";

/**
 * Mirrors `REASONING_EFFORTS` in `@inhuman.tools/plugin-sdk`. Inlined so this
 * package stays dependency-light; harness has a test that the two lists match.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const nonempty = z.string().trim().min(1);

/** Access to one already-running MCP server, by the server's name. */
export const botMcpGrantSchema = z.strictObject({
  server: nonempty,
  tools: z.array(nonempty).optional(),
  account: nonempty.optional(),
  session: nonempty.optional(),
});

export type BotMcpGrant = z.infer<typeof botMcpGrantSchema>;

export const kvScopeSchema = z.enum(["session", "project", "kernel"]).default("session");

export const kvSetInput = z.object({
  key: z.string().trim().min(1, "key is required"),
  value: z.string(),
  scope: kvScopeSchema,
  /**
   * Session `model` / `connection` also become the last-choice default
   * (project + kernel). `/model` and `/connect` send "1". Scheme #t does
   * not survive the action JSON walk. A bare session write — subagent,
   * `--model`, `--connection` — does not.
   */
  remember: z
    .union([z.boolean(), z.literal("1")])
    .optional()
    .transform((value) => value === true || value === "1"),
});
export const kvClearInput = z.object({
  key: z.string().trim().min(1, "key is required"),
  scope: kvScopeSchema,
});
export const kvOutput = z.object({ ok: z.literal(true) });

/**
 * A plugin command's call into that plugin's own state. `args` is a JSON
 * object, since action params cross as strings. `field` names the argument
 * the composer text (`input`) fills; an empty `input` then refuses.
 */
export const pluginMethodInput = z.object({
  plugin: z.string().trim().min(1, "plugin is required"),
  method: z.string().trim().min(1, "method is required"),
  scope: z.enum(["session", "project", "global"]).default("session"),
  args: z.string().optional(),
  field: z.string().trim().optional(),
  input: z.string().optional(),
});
/** A failure is data, so a command body that reads state still renders; the TUI shows `error` for a fired action. */
export const pluginMethodOutput = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const policySetInput = z.object({
  policy: z.enum(["manual", "auto", "yolo"]),
});
export const policySetOutput = z.object({ ok: z.literal(true) });

export const termContinueSetInput = z.object({
  key: z.string().trim().min(1, "key is required"),
  sessionId: z.string().trim().min(1, "sessionId is required"),
});
export const termContinueClearInput = z.object({
  key: z.string().trim().min(1, "key is required"),
});
export const termContinueOutput = z.object({ ok: z.literal(true) });

/** One picture on a `turn`. Bytes are standard base64. The daemon stores them beside the session. */
export const turnVisualInput = z.object({
  mime: z.string().trim().min(1),
  bytesBase64: z.string().trim().min(1).max(7_000_000),
  sourcePath: z.string().optional(),
});

export const turnInput = z.object({
  prompt: z.string(),
  kind: z.enum(["steer", "queue", "continue"]).optional(),
  visuals: z.array(turnVisualInput).max(8).optional(),
});
export const turnOutput = z.object({ ok: z.literal(true) });

export const turnVisualReadInput = z.object({
  id: z.string().trim().min(1),
});
export const turnVisualReadOutput = z.object({
  id: z.string(),
  mime: z.string(),
  bytesBase64: z.string(),
  width: z.number(),
  height: z.number(),
  resizedFrom: z.object({ width: z.number(), height: z.number() }).nullable(),
  sourcePath: z.string().nullable(),
});

/** A blob the session's document references by content hash (`StoredBlob.sha256`). */
export const blobGetInput = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
/** `text` for `text/*` media types, `bytesBase64` for everything else; exactly one is non-null. */
export const blobGetOutput = z.object({
  sha256: z.string(),
  bytes: z.number().int().min(0),
  mime: z.string(),
  text: z.string().nullable(),
  bytesBase64: z.string().nullable(),
});

/** `dryRun` counts what would move and writes nothing. */
export const blobVacuumInput = z.object({
  dryRun: z.boolean().optional(),
});
/** What moved (or, on a dry run, would): entities by seat, the UTF-8 bytes taken out of the document, and the stored image's size either side. */
export const blobVacuumOutput = z.object({
  dryRun: z.boolean(),
  fileMutates: z.number().int().min(0),
  promptMessages: z.number().int().min(0),
  promptTexts: z.number().int().min(0),
  bytesMoved: z.number().int().min(0),
  imageBytesBefore: z.number().int().min(0),
  imageBytesAfter: z.number().int().min(0),
});

export const connectAdoptInput = z.object({
  driver: z.union([
    z.string().trim().min(1),
    z.object({ name: z.string().trim().min(1) }).transform((row) => row.name),
  ]),
  name: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});
export const connectAdoptOutput = z.union([z.object({ id: z.string() }), z.object({ ok: z.literal(false) })]);
export const sessionConnectAdoptOutput = z.union([connectAdoptOutput, uiFormSchema]);
export const connectDropInput = z.object({
  id: z.string().trim().min(1, "id is required"),
  confirm: z.boolean().optional(),
});
export const connectDropOutput = z.object({ ok: z.boolean() });

export const mcpServerAdoptInput = z.object({
  name: z.string().optional(),
  input: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});
export const mcpServerAdoptOutput = connectAdoptOutput;

export const mcpServerSearchInput = z.object({
  query: z.string().trim().min(1, "query is required"),
  limit: z.number().int().min(1).max(20).optional(),
});
export const mcpServerSearchHit = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  install: z.string(),
});
export const mcpServerSearchOutput = z.object({
  servers: z.array(mcpServerSearchHit),
});

export const pluginSetInput = z
  .object({
    name: z.string().trim().min(1, "name is required"),
    enabled: z.boolean().optional(),
    foreground: z.boolean().optional(),
  })
  .refine((row) => row.enabled !== undefined || row.foreground !== undefined, {
    message: "enabled or foreground is required",
  });
export const pluginSetOutput = z.object({ ok: z.literal(true) });

export const pluginInstallInput = z.object({
  spec: z.string().trim().min(1, "spec is required"),
});
export const pluginInstallOutput = z.object({
  name: z.string(),
  npmName: z.string(),
});
export const pluginRemoveInput = z.object({
  name: z.string().trim().min(1, "name is required"),
});
export const pluginRemoveOutput = z.object({ ok: z.literal(true) });

/** Rename or merge settings of a connection that already exists. The id stays. */
export const connectUpdateInput = z
  .object({
    id: z.string().trim().min(1, "id is required"),
    name: z.string().trim().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((row) => row.name !== undefined || row.settings !== undefined, {
    message: "name or settings is required",
  });
export const connectUpdateOutput = z.object({ ok: z.literal(true) });

export const configSetInput = z.object({
  compact: z.string().optional(),
  compactKeepTurns: z.number().int().positive().optional(),
  compactTriggers: z.object({ hard: z.string().optional(), soft: z.string().optional() }).optional(),
  contextGlowRemaining: z.string().optional(),
  autoModeClassifier: z.string().optional(),
  defaultPermissionMode: z.enum(["manual", "auto", "yolo"]).optional(),
  approvalAskThrottleMs: z.number().finite().nonnegative().optional(),
  shellTailBytes: z.number().finite().nonnegative().optional(),
  superKey: z.enum(["ctrl", "cmd"]).optional(),
  hideFloorTools: z.boolean().optional(),
  statusline: z.string().optional(),
  statuslineRefresh: z.string().optional(),
  speculativePolicyProcessingTools: z.number().finite().nonnegative().optional(),
  textOnlyContinue: z.boolean().optional(),
  /** The user layer of the authorization table (validated by the daemon). `null` clears it. */
  authorization: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const configSetOutput = z.object({ ok: z.literal(true) });

const skillScope = z.enum(["project", "home"]);
export const skillListInput = z.object({
  project: z.string().optional(),
});
export const skillRowSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  invoke: z.string(),
  scope: skillScope,
});
export const skillListOutput = z.object({ skills: z.array(skillRowSchema) });
export const skillWriteInput = z.object({
  scope: skillScope,
  project: z.string().optional(),
  name: z.string().trim().min(1, "name is required"),
  description: z.string().default(""),
  body: z.string().default(""),
});
export const skillWriteOutput = skillRowSchema;
export const skillRemoveInput = z.object({
  scope: skillScope,
  project: z.string().optional(),
  name: z.string().trim().min(1, "name is required"),
});
export const skillRemoveOutput = z.object({ ok: z.literal(true) });
export const skillReadInput = skillRemoveInput;
export const skillReadOutput = skillRowSchema.extend({ body: z.string() });

const recipeScope = z.enum(["session", "project", "global"]);
export const botWriteInput = z.object({
  scope: z.enum(["home", "project"]),
  project: z.string().optional(),
  name: z.string().trim().min(1, "name is required"),
  description: z.string().default(""),
  instructions: z.string().default(""),
  recipeScope: recipeScope.default("session"),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  keepAlive: z.boolean().default(false),
  /**
   * Absent means keep the file's current value. An empty list clears it.
   * A settings save that does not know these fields must not wipe them.
   */
  invokes: z.array(z.string().trim().min(1)).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional(),
  modelPreferences: z.array(z.string().trim().min(1)).optional(),
  /** Absent keeps the file's grants. An empty list clears them. */
  mcp: z.array(botMcpGrantSchema).optional(),
});
export const botWriteOutput = z.object({ ok: z.literal(true) });
export const botRemoveInput = z.object({
  scope: z.enum(["home", "project"]),
  project: z.string().optional(),
  name: z.string().trim().min(1, "name is required"),
});
export const botRemoveOutput = z.object({ ok: z.literal(true) });

export const compactInput = z.object({
  focus: z.string().optional(),
  from: z.literal("overflow").optional(),
});
export const compactOutput = z.union([
  z.object({ ok: z.literal(true), compacted: z.boolean() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export const renameInput = z.object({
  title: z.string(),
});
export const renameOutput = z.object({
  ok: z.literal(true),
  title: z.string(),
});

export const evalInput = z
  .object({
    requestId: z.string().trim().min(1, "requestId is required"),
    expr: z.string(),
    source: z.string().optional(),
    sourcePath: z.string().trim().min(1).optional(),
    policy: z.string().trim().optional().default("auto"),
  })
  .refine((value) => value.source == null || value.sourcePath != null, {
    message: "source requires sourcePath",
  });
export const evalOutput = z.union([
  z.object({
    ok: z.literal(true),
    turnId: z.string(),
    programId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.literal("policy_unavailable"),
    text: z.string(),
  }),
]);

export const turnCancelInput = z.union([
  z.object({ turnId: z.string().trim().min(1) }).strict(),
  z.object({ requestId: z.string().trim().min(1) }).strict(),
]);
export const turnCancelOutput = z.object({ ok: z.literal(true) });

export const turnRewindInput = z.object({
  turnId: z.string().trim().min(1),
});
export const turnRewindOutput = z.object({
  ok: z.literal(true),
  turnId: z.string(),
});

export const turnRetryInput = z.object({}).strict();
export const turnRetryOutput = z.object({ ok: z.literal(true) });

export const residentSetInput = z.object({ resident: z.boolean() });
export const residentSetOutput = z.object({ ok: z.literal(true) });

/** A queued row named by the id the client saw. Already drained or moved is `ok: false`. */
export const queueRowInput = z.object({ id: z.string().trim().min(1) });
export const queueRowOutput = z.object({ ok: z.boolean() });

export const agentCallsListInput = z.object({}).strict();
export const agentCallsListOutput = z.object({
  calls: z.array(
    z.object({
      requestId: z.string(),
      callerSessionId: z.string(),
      tool: z.string(),
      workerSessionId: z.string(),
      contributionRevision: z.string(),
      state: z.enum(["admitted", "accepted", "running", "paused", "terminal"]),
      blocker: z.string().nullable(),
      delivery: z.enum(["pending", "delivered"]),
      outcome: z.unknown().nullable(),
    }),
  ),
});

export const agentCallsInspectInput = z.object({
  requestId: z.string().trim().min(1),
});
export const agentCallsInspectOutput = z.union([
  agentCallsListOutput.shape.calls.element,
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export const agentCallsCancelInput = z.object({
  requestId: z.string().trim().min(1),
});
export const agentCallsCancelOutput = z.object({ ok: z.boolean() });
