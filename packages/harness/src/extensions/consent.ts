import { createHash } from "node:crypto";

import { PluginSurfaceError } from "./surface-error.js";

/**
 * Review-fatigue policy (design §3.7).
 *
 * Unchanged guard hashes never prompt.
 * Every new or changed hash prompts, including signed packages.
 * A widening-only exemption is refused: a pure implementation change is
 * where a launder hides, and this tree has no separate trust root that
 * would make that exemption safe.
 */
export const GUARD_REVIEW_POLICY = {
  unverified: "prompt-on-any-hash-change",
  private: "prompt-on-any-hash-change",
  signed: "prompt-on-any-hash-change",
  unchanged: "silent",
} as const;

export type GuardIdentity = {
  readonly declarationId: string;
  readonly hash: string;
  readonly matchers: readonly string[];
  readonly guardCapability: string;
  readonly contract: string;
  readonly source: string;
  /** Digest of every loaded module, so an edited helper changes the hash. */
  readonly program: string;
};

export type GuardDiff = {
  readonly declarationId: string;
  readonly previousHash: string;
  readonly hash: string;
  readonly matchersAdded: readonly string[];
  readonly matchersRemoved: readonly string[];
  readonly capabilitiesGained: readonly string[];
  readonly capabilitiesLost: readonly string[];
  readonly sourceChanged: boolean;
  readonly programChanged: boolean;
};

export function guardHash(parts: {
  readonly declarationId: string;
  readonly point: string;
  readonly matchers: readonly string[];
  readonly guardCapability: string;
  readonly contract: string;
  readonly source: string;
  readonly program: string;
}): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Order-independent digest of a program's modules. */
export function programDigest(modules: ReadonlyMap<string, string>): string {
  const rows = [...modules].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function consentKey(scope: string, scopeId: string, plugin: string, hash: string): string {
  return `${scope}\0${scopeId}\0${plugin}\0${hash}`;
}

/** Host-owned. Scheme programs never receive this object. */
export class GuardConsentStore {
  readonly #approved = new Set<string>();

  approve(scope: "project" | "kernel", scopeId: string, plugin: string, hash: string): void {
    this.#approved.add(consentKey(scope, scopeId, plugin, hash));
  }

  has(scope: "project" | "kernel", scopeId: string, plugin: string, hash: string): boolean {
    return this.#approved.has(consentKey(scope, scopeId, plugin, hash));
  }
}

function diffOf(previous: GuardIdentity | undefined, next: GuardIdentity): GuardDiff {
  const priorMatchers = new Set(previous?.matchers);
  const nextMatchers = new Set(next.matchers);
  const priorCaps = new Set(
    previous == null ? [] : [previous.guardCapability, ...(previous.contract === "" ? [] : [previous.contract])],
  );
  const nextCaps = new Set([next.guardCapability, ...(next.contract === "" ? [] : [next.contract])]);
  return {
    declarationId: next.declarationId,
    previousHash: previous?.hash ?? "",
    hash: next.hash,
    matchersAdded: [...nextMatchers].filter((item) => !priorMatchers.has(item)),
    matchersRemoved: [...priorMatchers].filter((item) => !nextMatchers.has(item)),
    capabilitiesGained: [...nextCaps].filter((item) => !priorCaps.has(item)),
    capabilitiesLost: [...priorCaps].filter((item) => !nextCaps.has(item)),
    sourceChanged: (previous?.source ?? "") !== next.source,
    programChanged: (previous?.program ?? "") !== next.program,
  };
}

/**
 * Install and update review. `signed` is recorded and does not skip a prompt:
 * see `GUARD_REVIEW_POLICY`.
 */
export function reviewGuardUpdate(opts: {
  readonly plugin: string;
  readonly signed: boolean;
  readonly previous: readonly GuardIdentity[];
  readonly next: readonly GuardIdentity[];
  readonly store: GuardConsentStore;
  readonly scope: "project" | "kernel";
  readonly scopeId: string;
  readonly answer: (diff: GuardDiff) => boolean;
}): { readonly prompts: readonly GuardDiff[]; readonly signed: boolean } {
  const prompts: GuardDiff[] = [];
  const priorById = new Map(opts.previous.map((guard) => [guard.declarationId, guard]));
  for (const guard of opts.next) {
    const prior = priorById.get(guard.declarationId);
    if (prior?.hash === guard.hash) {
      PluginSurfaceError.invariant(
        opts.store.has(opts.scope, opts.scopeId, opts.plugin, guard.hash),
        "unapproved guard",
      );
      continue;
    }
    const diff = diffOf(prior, guard);
    prompts.push(diff);
    PluginSurfaceError.invariant(opts.answer(diff), "guard consent denied");
    opts.store.approve(opts.scope, opts.scopeId, opts.plugin, guard.hash);
  }
  return { prompts, signed: opts.signed };
}
