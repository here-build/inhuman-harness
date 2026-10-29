/**
 * A human answer to a live ask or soft-deny, applied by the daemon. The desk is the answering
 * client's session: it takes the session read root and the session grant. The leaf may sit on a worker
 * that escalated its ask.
 *
 * - A `block` is never put to a human: the answer is refused (it would be a lift).
 * - A soft-deny is licensed per call. `store` on it is refused and the answer is not applied.
 * - An ask may be remembered as a grant, but only as one of the subjects the daemon offers for this
 *   exact job (`grantOptions`): a client cannot widen what it stores.
 * - A comment is a reply to the agent, so it widens and stores nothing.
 */
import {
  ACKED_ONCE,
  type ApprovableJob,
  DEFAULT_PROMPT_TTL,
  grantLabel,
  mcpReadFloorDenies,
  type McpPersistScope,
  MCPToolJob,
  type GrantRow,
  type GrantScope,
  type GrantSubject,
  parseAuthorizationConfig,
  parseGrantRows,
  parseTtl,
  sameSubject,
  type SessionRoot,
} from "@inhuman.tools/harness-model";
import { runInAction } from "mobx";

export type AskStore = {
  readonly scope: GrantScope;
  readonly subject: GrantSubject;
  /** `null`: no expiry. Absent: the prompt default for the scope. */
  readonly ttlMs?: number | null;
};

export type AskAnswer = {
  readonly allow: boolean;
  readonly comment?: string;
  readonly widen?: string;
  readonly store?: AskStore;
  /** A combined prompt (ask + acknowledgement): also remember the acknowledgement. */
  readonly ackStore?: AskStore;
  /** Refusing an MCP look-up: hide the tool. Allowing is `store`. */
  readonly persist?: McpPersistScope;
};

export type AckAnswer = {
  readonly accept: boolean;
  readonly store?: AskStore;
  /** A refusal's comment is the reply the agent reads. */
  readonly comment?: string;
};

export type AckAnswerResult =
  | { readonly ok: true; readonly ack?: GrantRow }
  | { readonly ok: false; readonly reason: "not-pending" | "subject-not-offered" | "scope-unavailable" };

export type AskAnswerResult =
  | { readonly ok: true; readonly grant?: GrantRow }
  | {
      readonly ok: false;
      readonly reason:
        "block" | "soft-deny-not-storable" | "subject-not-offered" | "folder-not-allowed" | "scope-unavailable";
    };

/** What the daemon supplies: a clock, ids, configured TTLs, and the store of the persistent scopes. */
export type AnswerEnv = {
  readonly now: () => number;
  readonly newId: () => string;
  /** Configured `authorization.grants.promptTtl`, e.g. `{ project: "30d" }`. */
  readonly promptTtl?: Partial<Record<GrantScope, string | null>>;
  /** Persist a project, bot or global row. Absent: only session grants can be stored. */
  readonly persist?: (row: GrantRow) => void;
  /** The bot this session is, for bot-scope grants. */
  readonly bot?: string;
};

let counter = 0;
const defaultEnv: AnswerEnv = {
  now: () => Date.now(),
  newId: () => `g-${Date.now().toString(36)}-${(counter++).toString(36)}`,
};

/** A comment is a reply to the agent, so it widens and persists nothing. */
export function applyAskAnswer(
  desk: SessionRoot,
  leaf: ApprovableJob,
  answer: AskAnswer,
  env: AnswerEnv = defaultEnv,
): AskAnswerResult {
  // I1: a block is final. It is not put to a human, so there is nothing to answer.
  if (leaf.policyResult === "block") return { ok: false, reason: "block" };
  const comment = (answer.comment ?? "").trim();
  const wantsStore = answer.allow && answer.store !== undefined && comment === "";
  if (wantsStore && leaf.policyResult === "deny") return { ok: false, reason: "soft-deny-not-storable" };
  let grant: GrantRow | undefined;
  if (wantsStore) {
    const store = answer.store!;
    if (!leaf.grantOptions.some((option) => sameSubject(option.subject, store.subject))) {
      return { ok: false, reason: "subject-not-offered" };
    }
    const made = makeRow("grant", desk, store, env);
    if (!made.ok) return made;
    grant = made.row;
  }
  // One prompt, not two: a combined ask + acknowledgement may also remember the acknowledgement.
  let ack: GrantRow | undefined;
  if (answer.allow && answer.ackStore !== undefined && comment === "" && leaf.ackPending) {
    const ackStore = answer.ackStore;
    if (!leaf.ackOptions.some((option) => sameSubject(option.subject, ackStore.subject))) {
      return { ok: false, reason: "subject-not-offered" };
    }
    const made = makeRow("ack", desk, ackStore, env);
    if (!made.ok) return made;
    ack = made.row;
  }
  const widening = answer.allow && answer.widen != null && answer.widen !== "" && comment === "";
  if (widening && !desk.addReadRoot(answer.widen!)) return { ok: false, reason: "folder-not-allowed" };
  runInAction(() => {
    if (comment !== "") leaf.approvalComment = comment;
    if (!answer.allow && answer.persist != null && comment === "" && leaf instanceof MCPToolJob) {
      if (mcpReadFloorDenies(leaf.serverToolName))
        desk.blockTool(leaf.connectionKey, leaf.serverToolName, answer.persist);
    }
    if (grant !== undefined) save(desk, grant, env);
    if (ack !== undefined) save(desk, ack, env);
    // The person who allowed a combined prompt saw the acknowledgement on it: one prompt, not two.
    if (answer.allow && leaf.ackPending) leaf.stampAck("satisfied", ACKED_ONCE);
    leaf.humanApprove = answer.allow;
  });
  return grant === undefined ? { ok: true } : { ok: true, grant };
}

/**
 * A human answer to a pending acknowledgement. Accepting lets the call run (and a combined ask +
 * acknowledgement is one prompt: it also settles the ask); refusing is a human denial, not a policy
 * denial. `store` remembers the acknowledgement, but only as a subject the daemon offers for this job.
 */
export function applyAckAnswer(
  desk: SessionRoot,
  leaf: ApprovableJob,
  answer: AckAnswer,
  env: AnswerEnv = defaultEnv,
): AckAnswerResult {
  if (!leaf.ackPending || leaf.humanApprove !== null) return { ok: false, reason: "not-pending" };
  const comment = (answer.comment ?? "").trim();
  let ack: GrantRow | undefined;
  if (answer.accept && answer.store !== undefined) {
    const store = answer.store;
    if (!leaf.ackOptions.some((option) => sameSubject(option.subject, store.subject))) {
      return { ok: false, reason: "subject-not-offered" };
    }
    const made = makeRow("ack", desk, store, env);
    if (!made.ok) return made;
    ack = made.row;
  }
  runInAction(() => {
    if (comment !== "") leaf.approvalComment = comment;
    if (ack !== undefined) save(desk, ack, env);
    if (answer.accept) {
      leaf.stampAck("satisfied", ACKED_ONCE);
      // A prompt that was also an ask: the same yes settles it. An ack-only prompt needs no more.
      if (leaf.baseLicenseDetail.decision !== true) leaf.humanApprove = true;
    } else {
      leaf.stampAck("refused", null);
      leaf.humanApprove = false;
    }
  });
  return ack === undefined ? { ok: true } : { ok: true, ack };
}

function makeRow(
  kind: "grant" | "ack",
  desk: SessionRoot,
  store: AskStore,
  env: AnswerEnv,
): { readonly ok: true; readonly row: GrantRow } | { readonly ok: false; readonly reason: "scope-unavailable" } {
  if (store.scope !== "session" && env.persist === undefined) return { ok: false, reason: "scope-unavailable" };
  if (store.scope === "bot" && env.bot === undefined) return { ok: false, reason: "scope-unavailable" };
  const ttl =
    store.ttlMs === undefined
      ? parseTtl(env.promptTtl?.[store.scope] ?? DEFAULT_PROMPT_TTL[store.scope])
      : store.ttlMs;
  const now = env.now();
  return {
    ok: true,
    row: {
      id: env.newId(),
      ...(kind === "ack" ? { kind } : {}),
      scope: store.scope,
      scopeKey: scopeKeyOf(desk, store.scope, env),
      subject: store.subject,
      createdAtMs: now,
      expiresAtMs: ttl === null ? null : now + ttl,
      source: "prompt",
      label: grantLabel(store.subject),
    },
  };
}

function save(desk: SessionRoot, row: GrantRow, env: AnswerEnv): void {
  if (row.scope === "session") {
    desk.replaceGrantsJson(JSON.stringify([...parseGrantRows(desk.grantsJson), row]));
  } else {
    env.persist?.(row);
  }
}

function scopeKeyOf(desk: SessionRoot, scope: GrantScope, env: AnswerEnv): string {
  switch (scope) {
    case "session":
      return desk.sessionId;
    case "project":
      return desk.path;
    case "bot":
      return env.bot ?? "";
    case "global":
      return "";
  }
}

/** `authorization.grants.promptTtl` from the user layer: the TTL a prompt-created grant gets, per scope. */
export function promptTtlOf(userLayerJson: string): Partial<Record<GrantScope, string | null>> {
  const parsed = parseAuthorizationConfig(userLayerJson);
  return parsed.ok ? (parsed.config.grants?.promptTtl ?? {}) : {};
}
