/**
 * A connect failure as a person should read it. Every connect surface shares
 * this mapping: one sentence naming what happened, and the daemon's line only
 * when that sentence replaces it.
 *
 * `auth` is a refused key (401/403). The sentence says to reconnect. Anything
 * else, including a timeout or a refused socket, is a `connection` failure and
 * does not. A status is checked before a dead socket, so "HTTP 401 after
 * timeout" stays auth.
 */
export type FailureKind = "auth" | "connection";

export type ConnectFailure = {
  readonly kind: FailureKind;
  readonly summary: string;
  /** The daemon's own line, when the summary is not that line. */
  readonly detail: string | null;
};

/** `provider` is the offer's name. A blank name still leaves the sentence whole. */
export function connectError(provider: string, message: string): ConnectFailure {
  const name = provider.trim() === "" ? "The provider" : provider.trim();
  const line = message.trim();
  if (line === "") return { kind: "connection", summary: `Couldn’t connect to ${name}.`, detail: null };
  const { kind, summary } = summaryFor(name, line);
  return { kind, summary, detail: summary === line ? null : line };
}

function summaryFor(name: string, line: string): { readonly kind: FailureKind; readonly summary: string } {
  if (AUTH_STATUS.test(line)) return { kind: "auth", summary: "The key was refused. Reconnect." };
  if (TIMEOUT.test(line)) return { kind: "connection", summary: `No answer from ${name}.` };
  if (REFUSED.test(line)) {
    return { kind: "connection", summary: `${name} didn’t answer on this machine. Check it’s running, then retry.` };
  }
  return { kind: "connection", summary: line };
}

/** 401 or 403 as a status, not a digit inside a longer number. */
const AUTH_STATUS = /(?:^|\D)40[13](?:\D|$)/;
const TIMEOUT = /\b(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b|\btimed?\s*out\b/i;
const REFUSED = /\bECONNREFUSED\b|connection refused/i;
