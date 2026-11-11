/**
 * UTF-8 JSON reactivity plane routing on the shared daemon room socket.
 *
 * All clients in a room share a single daemon room WebSocket. As with JSON-RPC ids (`rpc.ts`),
 * two browsers may both subscribe with `subscriptionId: "s1"`, so the relay prefixes each
 * browser's `subscriptionId` with `<clientTag>:` on the way to the daemon and restores the
 * original `subscriptionId` on inbound `shape/delta` frames addressed to that browser.
 *
 * Browsers are untrusted writers on the reactivity plane: only `shape/subscribe`,
 * `shape/unsubscribe`, `presence/update`, `presence/query`, `ping`, and `pong` are accepted
 * from browsers; server-authoritative frames (`shape/delta`, `presence/state`, `stream/delta`)
 * sent by a browser are dropped.
 */

export type PresenceClient = readonly [id: number, clock: number];

export interface AnnouncedPresence {
  readonly id: number;
  readonly clock: number;
  readonly removed: boolean;
}

export interface StoredSubscription {
  readonly id: string;
  readonly lane: string;
  readonly params?: Record<string, unknown>;
  readonly offset?: number;
}

export type BrowserPlaneOutcome =
  | { readonly kind: "not-plane" }
  | { readonly kind: "drop" }
  | { readonly kind: "reply"; readonly text: string }
  | {
      readonly kind: "subscribe";
      readonly sub: StoredSubscription;
      readonly daemonText: string;
    }
  | {
      readonly kind: "unsubscribe";
      readonly subscriptionId: string;
      readonly daemonText: string;
    }
  | {
      readonly kind: "presence-update";
      readonly entries: readonly AnnouncedPresence[];
      readonly text: string;
    }
  | {
      readonly kind: "presence-query";
      readonly text: string;
    };

export type DaemonPlaneOutcome =
  | { readonly kind: "not-plane" }
  | { readonly kind: "drop" }
  | { readonly kind: "to"; readonly clientTag: string; readonly text: string }
  | { readonly kind: "broadcast"; readonly text: string };

const TAGGED = /^([\da-f]+):(.*)$/s;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function encodeTaggedSubscribe(clientTag: string, sub: StoredSubscription): string {
  return JSON.stringify({
    kind: "shape/subscribe",
    subscriptionId: `${clientTag}:${sub.id}`,
    lane: sub.lane,
    ...(sub.params === undefined ? {} : { params: sub.params }),
    ...(sub.offset === undefined ? {} : { offset: sub.offset }),
  });
}

export function encodeTaggedUnsubscribe(clientTag: string, subscriptionId: string): string {
  return JSON.stringify({
    kind: "shape/unsubscribe",
    subscriptionId: `${clientTag}:${subscriptionId}`,
  });
}

export const PRESENCE_QUERY_TEXT = '{"kind":"presence/query"}';

export function readPresenceEntries(rawEntries: unknown): AnnouncedPresence[] | null {
  if (!Array.isArray(rawEntries)) return null;
  const parsed: AnnouncedPresence[] = [];
  for (const item of rawEntries) {
    if (!Array.isArray(item) || item.length < 3) return null;
    const [id, state, clock] = item as [unknown, unknown, unknown];
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) return null;
    if (typeof clock !== "number" || !Number.isInteger(clock) || clock < 0) return null;
    if (state !== null && !isRecord(state)) return null;
    parsed.push({ id, clock, removed: state === null });
  }
  return parsed;
}

export function encodePresenceRemoval(clients: readonly PresenceClient[]): string {
  return JSON.stringify({
    kind: "presence/update",
    entries: clients.map(([id, clock]) => [id, null, clock + 1]),
  });
}

export function routeBrowserPlane(text: string, clientTag: string): BrowserPlaneOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "not-plane" };
  }
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return { kind: "not-plane" };
  }

  switch (raw.kind) {
    case "ping": {
      const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : undefined;
      return {
        kind: "reply",
        text: JSON.stringify(ts === undefined ? { kind: "pong" } : { kind: "pong", ts }),
      };
    }
    case "pong":
      return { kind: "drop" };
    case "shape/subscribe": {
      if (typeof raw.subscriptionId !== "string" || raw.subscriptionId === "") return { kind: "drop" };
      if (typeof raw.lane !== "string" || raw.lane === "") return { kind: "drop" };
      const params = isRecord(raw.params) ? raw.params : undefined;
      const offset = typeof raw.offset === "number" && Number.isInteger(raw.offset) ? raw.offset : undefined;
      const sub: StoredSubscription = {
        id: raw.subscriptionId,
        lane: raw.lane,
        ...(params === undefined ? {} : { params }),
        ...(offset === undefined ? {} : { offset }),
      };
      return {
        kind: "subscribe",
        sub,
        daemonText: encodeTaggedSubscribe(clientTag, sub),
      };
    }
    case "shape/unsubscribe": {
      if (typeof raw.subscriptionId !== "string" || raw.subscriptionId === "") return { kind: "drop" };
      return {
        kind: "unsubscribe",
        subscriptionId: raw.subscriptionId,
        daemonText: encodeTaggedUnsubscribe(clientTag, raw.subscriptionId),
      };
    }
    case "presence/update": {
      const entries = readPresenceEntries(raw.entries);
      if (entries === null) return { kind: "drop" };
      return { kind: "presence-update", entries, text };
    }
    case "presence/query":
      return { kind: "presence-query", text: PRESENCE_QUERY_TEXT };
    case "shape/delta":
    case "presence/state":
    case "stream/delta":
      // Server-authoritative frames: browsers cannot forge state deltas to the daemon or peers.
      return { kind: "drop" };
    default:
      return { kind: "drop" };
  }
}

export function routeDaemonPlane(text: string): DaemonPlaneOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "not-plane" };
  }
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return { kind: "not-plane" };
  }

  switch (raw.kind) {
    case "ping":
      // Keepalive from daemon; forward to browsers so client watchdogs observe room liveness.
      return { kind: "broadcast", text };
    case "pong":
      return { kind: "drop" };
    case "shape/delta": {
      if (typeof raw.subscriptionId !== "string") return { kind: "drop" };
      const match = TAGGED.exec(raw.subscriptionId);
      if (match === null) {
        return { kind: "broadcast", text };
      }
      return {
        kind: "to",
        clientTag: match[1]!,
        text: JSON.stringify({ ...raw, subscriptionId: match[2]! }),
      };
    }
    case "presence/update":
    case "presence/state":
    case "presence/query":
    case "stream/delta":
      return { kind: "broadcast", text };
    default:
      return { kind: "drop" };
  }
}
