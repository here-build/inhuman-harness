/**
 * The acknowledgement prompt, as data. A pending ack is an ordinary approval head with `ackPending`;
 * this says which of three prompts it is and builds the RPC each button sends. The daemon validates
 * every `store` against its own `ackOptions`, so the options here are offered, never trusted.
 */
import { DEFAULT_PROMPT_TTL, type GrantSubject } from "@inhuman.tools/harness-model/session";

export type AckScope = "session" | "project" | "bot" | "global";

/**
 * `ask`: the usual approval. `ack`: policy allows the call, only the acknowledgement is missing.
 * `ask+ack`: both are open, one prompt; Allow settles both.
 */
export type PromptKind = "ask" | "ack" | "ask+ack";

export type AckLeaf = {
  readonly ackPending: boolean;
  readonly baseLicenseDetail: { readonly decision: boolean | null };
};

export type AckFlagFace = { readonly label: string; readonly why?: string | undefined };
export type AckOptionFace = { readonly subject: GrantSubject; readonly label: string };

export function promptKind(leaf: AckLeaf): PromptKind {
  if (!leaf.ackPending) return "ask";
  return leaf.baseLicenseDetail.decision === true ? "ack" : "ask+ack";
}

const SCOPE_ORDER: readonly AckScope[] = ["session", "project", "bot", "global"];
const SCOPE_WORD: Readonly<Record<AckScope, string>> = {
  session: "this session",
  project: "this project",
  bot: "this bot",
  global: "everywhere",
};

export type StoreChoice = {
  /** Stable within a prompt; the select's value. */
  readonly key: string;
  readonly scope: AckScope;
  readonly subject: GrantSubject;
  /** `<subject> · <scope> · <ttl>`; the ttl is dropped when it is the scope itself (session). */
  readonly text: string;
  readonly ttl: string;
};

/** "7d" reads "7 days"; no TTL is the session's own life. */
export function ttlText(ttl: string | null): string {
  if (ttl === null) return "this session";
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (match === null) return ttl;
  const unit = { s: "second", m: "minute", h: "hour", d: "day" }[match[2] as "s" | "m" | "h" | "d"];
  const count = Number(match[1]);
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** Every offered subject at every scope the session can use. Bot scope is only for a bot's own session. */
export function storeChoices(options: readonly AckOptionFace[], opts: { readonly bot: boolean }): StoreChoice[] {
  const scopes = SCOPE_ORDER.filter((scope) => scope !== "bot" || opts.bot);
  const out: StoreChoice[] = [];
  options.forEach((option, index) => {
    for (const scope of scopes) {
      const ttl = ttlText(DEFAULT_PROMPT_TTL[scope]);
      out.push({
        key: `${index}:${scope}`,
        scope,
        subject: option.subject,
        // The session's own life is both scope and expiry: say it once.
        text: DEFAULT_PROMPT_TTL[scope] === null ? `${option.label} · ${SCOPE_WORD[scope]}` : `${option.label} · ${SCOPE_WORD[scope]} · ${ttl}`,
        ttl,
      });
    }
  });
  return out;
}

export function choiceByKey(choices: readonly StoreChoice[], key: string): StoreChoice | null {
  return choices.find((choice) => choice.key === key) ?? null;
}

const storeOf = (choice: StoreChoice | null) =>
  choice == null ? {} : { store: { scope: choice.scope, subject: choice.subject } };

export type AnswerRequest = { readonly method: "ack/answer" | "ask/answer"; readonly params: Record<string, unknown> };

/**
 * What a button sends. An ack-only prompt answers `ack/answer`; Refuse is `accept: false`. A combined
 * prompt answers `ask/answer`, whose allow settles the ack too, and `ackStore` remembers it.
 */
export function answerRequest(input: {
  readonly kind: PromptKind;
  readonly sessionId: string;
  readonly jobId: string;
  readonly yes: boolean;
  readonly comment?: string;
  readonly remember?: StoreChoice | null;
}): AnswerRequest {
  const note = input.comment?.trim() ?? "";
  const comment = note === "" ? {} : { comment: note };
  if (input.kind === "ack") {
    return {
      method: "ack/answer",
      params: {
        sessionId: input.sessionId,
        jobId: input.jobId,
        ackId: input.jobId,
        accept: input.yes,
        ...(input.yes ? storeOf(input.remember ?? null) : {}),
        ...comment,
      },
    };
  }
  const remembered = input.yes && input.kind === "ask+ack" && input.remember != null;
  return {
    method: "ask/answer",
    params: {
      sessionId: input.sessionId,
      jobId: input.jobId,
      allow: input.yes,
      ...(remembered ? { ackStore: storeOf(input.remember ?? null).store } : {}),
      ...comment,
    },
  };
}

export type AckCopy = {
  readonly kicker: string;
  readonly lede: string;
  readonly yes: string;
  readonly no: string;
};

/** Words for the prompt. Soft-deny keeps its own copy: nothing of the grant is remembered. */
export function ackCopy(kind: PromptKind, softDeny: boolean): AckCopy {
  if (kind === "ack") {
    return {
      kicker: "Acknowledgement needed",
      lede: "Policy allows this call, but it needs your acknowledgement before it runs.",
      yes: "Acknowledge",
      no: "Refuse",
    };
  }
  if (kind === "ask+ack") {
    return {
      kicker: softDeny ? "Soft-deny and acknowledgement" : "Approval and acknowledgement",
      lede: softDeny
        ? "Runs only with your say-so, every time, and it also needs your acknowledgement. Allow settles both."
        : "This call needs your approval and your acknowledgement. Allow settles both.",
      yes: "Allow",
      no: "Deny",
    };
  }
  return { kicker: "", lede: "", yes: "Allow", no: "Deny" };
}
