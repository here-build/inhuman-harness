/**
 * The acknowledgement prompt, as data. A flag (`needsAcknowledgement`) makes a call wait for a person
 * even when the license would let it run. Three shapes:
 *
 *  - `ack`           the call is allowed; only the acknowledgement is asked.
 *  - `ask+ack`       an ask, also flagged: one prompt, a human yes settles both.
 *  - `soft-deny+ack` a soft-deny, also flagged: the soft-deny is never remembered, the ack may be.
 *
 * Pure: no job, no RPC. Tea feeds it the job's stamps and sends what the chords say.
 */
import type { AckOption, GrantSubject, MatchedAck } from "@inhuman.tools/harness-model";

export type AckScope = "session" | "project" | "bot" | "global";
export type AckVariant = "ack" | "ask+ack" | "soft-deny+ack";

/** What a prompt-created ack lasts in the daemon (`ack/pending` storeOptions[].defaultTtlMs): session ends with the session. */
export const ACK_PROMPT_TTL_DAYS = 7;

export type AckChoice = {
  readonly scope: AckScope;
  readonly subject: GrantSubject;
  readonly label: string;
  /** "this session" or "7 days". */
  readonly ttl: string;
  /** "<label> · <scope> · <ttl>" (session scope drops the ttl), as the chord shows it. */
  readonly text: string;
};

export type AckPromptModel = {
  readonly variant: AckVariant;
  /** "✉ Acknowledge · gmail · send_email" (ack-only) or "Also flagged · ..." (combined). */
  readonly header: string;
  /** Quoted `why` of each flag that gave one. */
  readonly whys: readonly string[];
  readonly copy: string;
  readonly choices: readonly AckChoice[];
};

const SCOPE_PHRASE: Readonly<Record<AckScope, string>> = {
  session: "this session",
  project: "this project",
  bot: "this bot",
  global: "everywhere",
};

/** Each offered subject at each scope the session can store to. */
export function ackChoices(options: readonly AckOption[], session: { readonly bot: boolean }): AckChoice[] {
  const scopes: AckScope[] = session.bot ? ["session", "project", "bot", "global"] : ["session", "project", "global"];
  const out: AckChoice[] = [];
  for (const option of options) {
    for (const scope of scopes) {
      const ttl = scope === "session" ? "this session" : `${ACK_PROMPT_TTL_DAYS} days`;
      out.push({
        scope,
        subject: option.subject,
        label: option.label,
        ttl,
        // The session's own life is both scope and expiry: say it once.
        text: scope === "session" ? `${option.label} · ${SCOPE_PHRASE[scope]}` : `${option.label} · ${SCOPE_PHRASE[scope]} · ${ttl}`,
      });
    }
  }
  return out;
}

export function ackVariant(input: {
  readonly ackPending: boolean;
  readonly policyResult: "policyApprove" | "ask" | "deny" | "block" | null;
  /** `baseLicenseDetail.decision`: true when the license alone would let the call run. */
  readonly baseDecision: boolean | null;
}): AckVariant | null {
  if (!input.ackPending || input.policyResult === "block" || input.policyResult === null) return null;
  if (input.baseDecision === true) return "ack";
  return input.policyResult === "deny" ? "soft-deny+ack" : "ask+ack";
}

export function ackPromptModel(input: {
  readonly variant: AckVariant;
  readonly flags: readonly MatchedAck[];
  readonly options: readonly AckOption[];
  readonly bot: boolean;
}): AckPromptModel {
  const labels = [...new Set(input.flags.map((flag) => flag.label))];
  const whys = input.flags.flatMap((flag) => (flag.why === undefined || flag.why === "" ? [] : [flag.why]));
  const what = labels.join(", ");
  const head = input.variant === "ack" ? "✉ Acknowledge" : "✉ Also flagged";
  return {
    variant: input.variant,
    header: what === "" ? head : `${head} · ${what}`,
    whys: [...new Set(whys)].map((why) => `"${why}"`),
    copy:
      input.variant === "ack"
        ? "Allowed by policy; you asked to confirm this first."
        : "You asked to confirm this call too: your answer settles both.",
    choices: ackChoices(input.options, { bot: input.bot }),
  };
}

/** The text the prompt pins over the box. */
export function ackAnnotation(model: AckPromptModel): string {
  return [model.header, model.whys.length === 0 ? undefined : model.whys.join(" "), model.copy]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

export function cycleAck(index: number, size: number, step: 1 | -1): number {
  return size <= 0 ? 0 : (index + step + size) % size;
}
