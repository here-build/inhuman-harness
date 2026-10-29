/**
 * Wire shapes of the policy v2 engine: grants (a stored human "yes" to an ask), the extended
 * `ask/answer`, `policy/explain`, the session overlay.
 *
 * The class ids are the closed taxonomy owned by `@inhuman.tools/policy` (classes.ts); a test in
 * `@inhuman.tools/harness` pins that this list equals it. Tier names on the wire are "soft-deny" and
 * "ask"; the engine names `deny` / `ask` appear only where a tier is a disposition.
 */
import { z } from "zod";

export const CLASS_IDS = [
  "destroy-catastrophic",
  "destroy-local",
  "vcs-history",
  "privilege",
  "credential",
  "control-plane",
  "attack-shape",
  "policy-fault",
  "package-install",
  "publish",
  "remote-write",
  "network-egress",
  "exec-unknown",
  "unmodelled",
  "envelope-read",
  "envelope-write",
  "protected-file",
  "workspace-write",
  "mcp-lookup",
  "mcp-action",
] as const;
export const classIdSchema = z.enum(CLASS_IDS);

export const GRANT_SCOPES = ["session", "project", "bot", "global"] as const;
export const grantScopeSchema = z.enum(GRANT_SCOPES);

/** What a grant covers. Commands are families: program + subcommand spine + `family_args`. */
export const grantSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      argv0: z.string().min(1),
      spine: z.array(z.string()),
      args: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      cluster: z.enum(["read", "write"]),
      path: z.string().min(1),
      depth: z.enum(["exact", "subtree"]),
    })
    .strict(),
  /** `account` is the connection id: one ConnectionSpec is one account. */
  z
    .object({
      kind: z.literal("mcp"),
      server: z.string().min(1),
      account: z.string().min(1).optional(),
      tool: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("tool"), name: z.string().min(1) }).strict(),
  /** Acknowledgements only: "any call of this class". */
  z.object({ kind: z.literal("class"), class: classIdSchema }).strict(),
]);

export const grantRowSchema = z
  .object({
    id: z.string().min(1),
    /** Absent: a grant (a stored "yes" to an ask). `ack`: a stored acknowledgement. */
    kind: z.enum(["grant", "ack"]).optional(),
    scope: grantScopeSchema,
    /** sessionId | project path | bot name | "" */
    scopeKey: z.string(),
    subject: grantSubjectSchema,
    createdAtMs: z.number().int(),
    /** `null`: no expiry (session grants end with the session; settings-file grants never expire). */
    expiresAtMs: z.number().int().nullable(),
    source: z.enum(["prompt", "settings"]),
    label: z.string(),
  })
  .strict();

export const grantListInput = z
  .object({
    /** Default `grant`. Acknowledgements are listed by `ack/list`. */
    kind: z.enum(["grant", "ack"]).optional(),
    scope: grantScopeSchema.optional(),
    sessionId: z.string().optional(),
    projectPath: z.string().optional(),
    bot: z.string().optional(),
    includeExpired: z.boolean().optional(),
  })
  .strict();
export const grantListOutput = z.object({ rows: z.array(grantRowSchema) });

export const grantAddInput = z
  .object({
    /** Default `grant`. */
    kind: z.enum(["grant", "ack"]).optional(),
    scope: grantScopeSchema,
    /** Required for session (the session id), project (its path) and bot (its name). */
    scopeKey: z.string().optional(),
    subject: grantSubjectSchema,
    ttlMs: z.number().int().positive().optional(),
  })
  .strict();
export const grantAddOutput = z.union([
  z.object({ ok: z.literal(true), row: grantRowSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["fenced-path", "invalid-scope", "unknown-session", "subject-not-allowed"]),
  }),
]);

export const grantRevokeInput = z.object({ id: z.string().min(1), sessionId: z.string().optional() }).strict();
export const grantRevokeOutput = z.object({ ok: z.boolean() });

/** Remember a human "yes" to an ask. Never for a soft-deny, never for a block. */
export const askStoreInput = z
  .object({
    scope: grantScopeSchema,
    /** Must be one of the subjects the daemon offers for this job (`grantOptions`). */
    subject: grantSubjectSchema,
    /** `null`: no expiry. Absent: the prompt default (session: none, project/bot/global: 7 days). */
    ttlMs: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const askAnswerInput = z.object({
  sessionId: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
  allow: z.boolean(),
  comment: z.string().optional(),
  /** "Treat <folder> as part of this session?" answered yes: the folder becomes a session read root. */
  widen: z.string().optional(),
  store: askStoreInput.optional(),
  /** A combined prompt (ask + acknowledgement): also remember the acknowledgement (one of `ackRequest.storeOptions`). */
  ackStore: askStoreInput.optional(),
  /** Refusing an MCP look-up: hide the tool for this session or for good. Allowing is `store`, not this. */
  persist: z.enum(["session", "always"]).optional(),
});
export const askAnswerOutput = z.object({
  ok: z.boolean(),
  reason: z
    .enum([
      "not-pending",
      "block",
      "soft-deny-not-storable",
      "subject-not-offered",
      "folder-not-allowed",
      "scope-unavailable",
    ])
    .optional(),
  grant: grantRowSchema.optional(),
});

/**
 * A call that is allowed but waits for the user's acknowledgement (a `needsAcknowledgement` flag). The
 * daemon holds the ledger; it is never a job, a transcript entry or a model-visible field.
 */
export const ackStoreOptionSchema = z.object({
  scope: grantScopeSchema,
  subject: grantSubjectSchema,
  label: z.string(),
  /** What a prompt-created ack lasts in this scope; `null` for the session's own life. */
  defaultTtlMs: z.number().int().nullable(),
});

export const ackRequestSchema = z.object({
  /** The job's id: stable while the call waits. */
  ackId: z.string(),
  sessionId: z.string(),
  jobId: z.string(),
  tool: z.string(),
  /** One line, e.g. `shell · git push origin main`. */
  summary: z.string(),
  /** The call's arguments, agent-written strings JSON-encoded and cut for display. */
  detail: z.string(),
  flags: z.array(
    z.object({
      label: z.string(),
      why: z.string().optional(),
      layer: z.enum(["dist", "managed", "user", "project", "session"]),
    }),
  ),
  verdict: z.object({
    tier: z.enum(["allow", "ask", "soft-deny"]),
    classes: z.array(classIdSchema),
    /** `pending`: the ask or soft-deny is not resolved yet; answering settles both (one prompt). */
    licensedBy: z.enum(["floor", "grant", "judge", "resolver", "pending"]),
  }),
  storeOptions: z.array(ackStoreOptionSchema),
  createdAtMs: z.number().int(),
});

export const ackPendingInput = z.object({ sessionId: z.string().optional() }).strict();
export const ackPendingOutput = z.object({ acks: z.array(ackRequestSchema) });

export const ackAnswerInput = z
  .object({
    sessionId: z.string().trim().min(1),
    jobId: z.string().trim().min(1),
    ackId: z.string().trim().min(1),
    accept: z.boolean(),
    /** Remember the acknowledgement. Must be one of `ackRequest.storeOptions`. */
    store: askStoreInput.optional(),
    /** A refusal's comment is what the agent reads. */
    comment: z.string().optional(),
  })
  .strict();
export const ackAnswerOutput = z.object({
  ok: z.boolean(),
  reason: z.enum(["not-pending", "subject-not-offered", "scope-unavailable"]).optional(),
  ack: grantRowSchema.optional(),
});

export const ackListInput = grantListInput.omit({ kind: true });
export const ackListOutput = grantListOutput;
export const ackAddInput = grantAddInput.omit({ kind: true });
export const ackAddOutput = grantAddOutput;
export const ackRevokeInput = grantRevokeInput;
export const ackRevokeOutput = grantRevokeOutput;

/** What a call is, for `policy/explain`. */
export const policyProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), command: z.string().min(1), cwd: z.string().optional() }).strict(),
  z.object({ kind: z.literal("path"), cluster: z.enum(["read", "write"]), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("mcp"),
      server: z.string().min(1),
      account: z.string().optional(),
      tool: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("tool"), name: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() })
    .strict(),
]);

export const policyExplainInput = z
  .object({
    probe: policyProbeSchema,
    mode: z.enum(["manual", "auto", "yolo"]).optional(),
    unattended: z.boolean().optional(),
  })
  .strict();

export const explainResolverSchema = z.object({
  /** allow | judge | human | deny */
  kind: z.enum(["allow", "judge", "human", "deny"]),
  layer: z.enum(["dist", "managed", "user", "project", "session"]),
  /** Judge cells only: what a judge deny / failure resolves to. */
  onDeny: z.enum(["human", "deny"]).optional(),
  onFail: z.enum(["human", "deny"]).optional(),
});

export const policyExplainOutput = z.object({
  /** The floor's tier: block | soft-deny | ask | allow. */
  tier: z.enum(["block", "soft-deny", "ask", "allow"]),
  classes: z.array(z.object({ id: classIdSchema, label: z.string() })),
  votes: z.array(
    z.object({
      tier: z.enum(["block", "soft-deny", "ask", "allow"]),
      class: classIdSchema,
      ruleId: z.string(),
      lift: z.string().optional(),
    }),
  ),
  /** Null for allow and block: the resolution table is not consulted. */
  resolver: explainResolverSchema.nullable(),
  /** A stored grant that would cover this call (ask only), else null. */
  grant: grantRowSchema.nullable(),
  /** What a prompt could offer to remember. Empty for soft-deny. */
  grantable: z.array(grantSubjectSchema),
  outcome: z.enum(["runs", "judge-ask", "judge-soft-deny", "prompts-you", "denied", "blocked"]),
  /**
   * Acknowledgement flags that cover the call in this mode, and the stored ack that satisfies them. Null
   * when no flag applies. An unsatisfied flag turns `runs` into a prompt (`prompts-you`) or, unattended, a denial.
   */
  ack: z
    .object({
      flags: z.array(z.object({ label: z.string(), why: z.string().optional(), layer: z.string() })),
      satisfiedBy: grantRowSchema.nullable(),
    })
    .nullable(),
  /** Why, in a sentence. */
  reason: z.string(),
});

export const policyOverlayInput = z
  .object({
    /** An `authorization` block for this session only, or `null` to clear it. Capped by the project layer. */
    overlay: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export const policyOverlayOutput = z.object({ ok: z.boolean(), errors: z.array(z.string()) });

export const policyConfigGetInput = z.object({}).strict();
export const policyConfigGetOutput = z.object({
  /** The layers as text ("" = none) and what is wrong with them, if anything. */
  layers: z.object({
    user: z.string(),
    project: z.string(),
    session: z.string(),
  }),
  warnings: z.array(z.string()),
});
