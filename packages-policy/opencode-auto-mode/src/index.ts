/**
 * OpenCode v2 `permission.hook("evaluate")`.
 * A configured deny never reaches this hook. A later plugin can rewrite `effect`.
 * The user program is `plugins[].options`.
 * `{env:NAME}` and `{file:path}` are expanded by OpenCode before `setup`.
 * This package is the structured-output seat. Sage and Jev are sibling packages.
 */
import {
  decideAnswer,
  decidePrompt,
  structuredOutputDecideCapability,
  type DecideComplete,
} from "@inhuman.tools/env-capability-decision-structured";
import {
  acknowledgeRequirement,
  authorize,
  checkToolPath,
  defaultPolicy,
  floorVerdictOf,
  mergeAcknowledge,
  parseAcknowledge,
  withDeadline,
  type AckFlag,
} from "@inhuman.tools/policy";

/** `ask` is the host's own prompt: a flagged call that would run is handed back to OpenCode to ask. */
export type Decision = "allow" | "deny" | "skip" | "ask";

export type HostEffect = "allow" | "ask" | "deny";

export type PermissionCall = {
  readonly action: string;
  readonly resources: readonly string[];
};

/**
 * OpenCode's real action names are not verifiable from this repo (the host types are not
 * installed), so every plausible spelling is gated: `bash` as well as `shell`, and the edit
 * family. `read` / `list` go through the read floor; a read the floor approves is left to
 * the host's own permission setting.
 */
const BASH_ACTIONS = new Set(["shell", "bash"]);
const WRITE_ACTIONS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const READ_ACTIONS = new Set(["read", "list"]);

export type PermissionEvaluation = PermissionCall & {
  effect: HostEffect;
};

/** A model named in the plugin options; OpenCode's own default model when absent. */
export type JudgeModel = { readonly id: string; readonly providerID: string; readonly variant?: string };

/** `experimental.generate.text` is stateless: no session, history or tools. The result may or may not be wrapped in `data`. */
export type GenerateText = (input: {
  readonly prompt: string;
  readonly model?: JudgeModel;
}) => Promise<{ readonly text?: string; readonly data?: { readonly text?: string } }>;

export type PermissionHost = {
  readonly options?: unknown;
  readonly experimental?: { readonly generate?: { readonly text?: GenerateText } };
  readonly permission: {
    hook(name: "evaluate", callback: (event: PermissionEvaluation) => void | Promise<void>): Promise<unknown>;
  };
};

export type KeyEnv = NodeJS.ProcessEnv;

/** Test seam. Production does not pass this. */
export type CallJudge = (document: string) => Promise<"allow" | "deny" | null>;

export type EvaluateOptions = {
  readonly env?: KeyEnv;
  readonly program?: string;
  /** A missing file denies. It does not fall through to the dist script. */
  readonly programPath?: string;
  readonly judge?: CallJudge;
  /**
   * The structured judge's model call, per document. `register` derives it from OpenCode's
   * `experimental.generate`. The structured capability's prompt does not carry the document, so
   * the factory is handed it to put in front of the model.
   */
  readonly complete?: DecideComplete;
  /** Anchor for relative and absolute resource paths. Default is the process cwd. */
  readonly cwd?: string;
  /** Per-vote judge budget; expiry denies. */
  readonly deadlineMs?: number;
  /** `needsAcknowledgement` flags (union of the user and project layers). Modes are ignored in adapters. */
  readonly acknowledgeFlags?: readonly AckFlag[];
};

export type PreparedCall =
  | { readonly kind: "skip" }
  | { readonly kind: "deny" }
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly documents: readonly string[] };

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function prepareCall(call: PermissionCall, cwd?: string): PreparedCall {
  const kind = BASH_ACTIONS.has(call.action)
    ? "bash"
    : WRITE_ACTIONS.has(call.action)
      ? "write"
      : READ_ACTIONS.has(call.action)
        ? "read"
        : undefined;
  if (kind === undefined || call.resources.length === 0) return { kind: "skip" };
  const documents: string[] = [];
  for (const resource of call.resources) {
    const floor =
      kind === "bash"
        ? defaultPolicy.bash(resource)
        : checkToolPath(kind, resource, cwd === undefined ? undefined : { cwd });
    if (floor === "block") return { kind: "deny" };
    if (floor === "ask" || floor === "deny") documents.push(resource);
  }
  if (documents.length === 0) return kind === "read" ? { kind: "skip" } : { kind: "allow" };
  return { kind: "ask", documents };
}

export async function voteDocuments(
  documents: readonly string[],
  vote: (document: string) => Promise<"allow" | "deny" | null>,
  deadlineMs?: number,
): Promise<Decision> {
  for (const document of documents) {
    try {
      if ((await withDeadline(vote(document), deadlineMs)) !== "allow") return "deny";
    } catch {
      return "deny";
    }
  }
  return "allow";
}

export function programOf(
  options: EvaluateOptions | undefined,
  env: NodeJS.ProcessEnv,
): {
  readonly program?: string;
  readonly env?: NodeJS.ProcessEnv;
} {
  const programFile = present(options?.programPath) ?? present(env.POLICY_AUTHORIZE);
  return {
    ...(options?.program === undefined ? {} : { program: options.program }),
    ...(programFile === undefined ? {} : { env: { POLICY_AUTHORIZE: programFile } }),
  };
}

/**
 * A call that would run (allow, or a skip that leaves it to the host's own setting) and matches an
 * acknowledgement flag becomes `ask`, OpenCode's own prompt. A deny stays a deny.
 * The local event type has no reason field, so the flag's `why` is not shown (unverified host API).
 */
export function applyAcknowledgement(
  call: PermissionCall,
  decision: Decision,
  options?: { readonly acknowledgeFlags?: readonly AckFlag[]; readonly cwd?: string },
): Decision {
  const flags = options?.acknowledgeFlags ?? [];
  if (flags.length === 0 || (decision !== "allow" && decision !== "skip")) return decision;
  const kind = BASH_ACTIONS.has(call.action)
    ? "bash"
    : WRITE_ACTIONS.has(call.action)
      ? "write"
      : READ_ACTIONS.has(call.action)
        ? "read"
        : undefined;
  const cwd = options?.cwd === undefined ? {} : { cwd: options.cwd };
  const subjects = kind === undefined || call.resources.length === 0 ? [undefined] : call.resources;
  for (const resource of subjects) {
    const verdict =
      resource === undefined || kind === undefined
        ? undefined
        : kind === "bash"
          ? floorVerdictOf({ kind, command: resource })
          : floorVerdictOf({ kind, path: resource, ...cwd });
    if (acknowledgeRequirement(flags, { tool: call.action, ...(verdict === undefined ? {} : { verdict }) }) !== null) {
      return "ask";
    }
  }
  return decision;
}

/** Flags from the plugin options: `acknowledge` (user) and `projectAcknowledge`. Invalid throws at load. */
export function acknowledgeFlagsOf(record: Readonly<Record<string, unknown>>): readonly AckFlag[] {
  return mergeAcknowledge(parseAcknowledge(record.acknowledge), parseAcknowledge(record.projectAcknowledge));
}

export async function evaluateCall(call: PermissionCall, options?: EvaluateOptions): Promise<Decision> {
  return applyAcknowledgement(call, await decideCall(call, options), options);
}

async function decideCall(call: PermissionCall, options?: EvaluateOptions): Promise<Decision> {
  const prepared = prepareCall(call, options?.cwd);
  if (prepared.kind !== "ask") return prepared.kind;
  const env = options?.env ?? process.env;
  const source = programOf(options, env);
  return voteDocuments(
    prepared.documents,
    (document) => {
      if (options?.judge !== undefined) return options.judge(document);
      return authorize(document, {
        capability: structuredOutputDecideCapability,
        ...(options?.complete === undefined ? {} : { config: { complete: options.complete } }),
        ...source,
      });
    },
    options?.deadlineMs,
  );
}

/** The judge asks OpenCode's own model. No `generate` means no `complete`, so a judged call denies. */
export function completeOf(ctx: PermissionHost, model?: JudgeModel): DecideComplete | undefined {
  const text = ctx.experimental?.generate?.text;
  if (text === undefined) return undefined;
  return async (request) => {
    const { system, user } = decidePrompt(request);
    const result = await text.call(ctx.experimental?.generate, {
      prompt: `${system}\n\n${user}`,
      ...(model === undefined ? {} : { model }),
    });
    const answer = result.text ?? result.data?.text;
    if (typeof answer !== "string") throw new Error("no text from generate");
    return decideAnswer(answer);
  };
}

function modelOf(value: unknown): JudgeModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, providerID, variant } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof providerID !== "string") return undefined;
  return { id, providerID, ...(typeof variant === "string" ? { variant } : {}) };
}

export async function register(ctx: PermissionHost, options?: EvaluateOptions): Promise<void> {
  const record: Record<string, unknown> = {};
  const raw = ctx.options;
  if (options === undefined && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    Object.assign(record, raw);
  }
  const program = typeof record.program === "string" ? record.program : undefined;
  const programPath = typeof record.programPath === "string" ? record.programPath : undefined;
  const acknowledgeFlags = options === undefined ? acknowledgeFlagsOf(record) : [];
  const resolved: EvaluateOptions = options ?? {
    ...(program === undefined ? {} : { program }),
    ...(programPath === undefined ? {} : { programPath }),
    ...(acknowledgeFlags.length === 0 ? {} : { acknowledgeFlags }),
  };
  const complete = resolved.complete ?? completeOf(ctx, modelOf(record.model));
  const withComplete: EvaluateOptions = complete === undefined ? resolved : { ...resolved, complete };
  await ctx.permission.hook("evaluate", async (event) => {
    const verdict = await evaluateCall(event, withComplete);
    // An earlier deny is never loosened to ask.
    if (verdict === "ask" && event.effect === "deny") return;
    if (verdict !== "skip") event.effect = verdict;
  });
}

const plugin = {
  id: "inhuman.policy-opencode",
  async setup(ctx: PermissionHost) {
    await register(ctx);
  },
};

export default plugin;
