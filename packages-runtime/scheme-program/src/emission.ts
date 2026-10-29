/**
 * Closure windows for one evaluation. The store is discarded: the track is
 * stamped on the child, and that is the record a replay matches.
 */
import type { ExecOptions, SchemeValue } from "@here.build/arrival";
import { buildWireframe } from "@here.build/arrival/provenance";

export type ProgramEmission = NonNullable<ExecOptions["emission"]>;

const store: ProgramEmission["store"] = {
  async append() {},
  async allocateSeq() {
    return 0;
  },
  async readStream() {
    return [];
  },
  async getHeader() {
    return undefined;
  },
  async putHeader() {},
};

const payloads: ProgramEmission["payloads"] = {
  async put() {},
  async get() {
    throw new Error("program emission does not read payloads");
  },
  async settle() {},
  async evict() {},
};

/** Verbs that start one track per element. Anything else is a source, so a lambda that calls it is a closure. */
const FANS = new Set([
  "map",
  "for-each",
  "filter",
  "filter-map",
  "partition",
  "append-map",
  "fold",
  "fold-right",
  "vector-map",
  "vector-for-each",
  "string-map",
  "string-for-each",
  "pair-for-each",
]);

const wireframeOptions = {
  classifier: {
    roleOf(op: string): "fan" | "source" {
      return FANS.has(op) ? "fan" : "source";
    },
  },
  isBaseName: (): boolean => false,
};

export function harnessEmission(forms: readonly SchemeValue[]): ProgramEmission {
  const closureSites = new Map<object, { readonly templateHash: string; readonly rootOrdinal: number }>();
  const emission: ProgramEmission = {
    store,
    payloads,
    regionId: "harness",
    coordinate: { templateHash: "harness", ordinalPath: [0], regionEpoch: "run" },
    closureSites,
  };
  extendEmission(emission, forms);
  return emission;
}

/** Same parsed pairs the following `execState` will run. Sites are keyed by pair identity. */
export function extendEmission(emission: ProgramEmission, forms: readonly SchemeValue[]): void {
  if (forms.length === 0 || !(emission.closureSites instanceof Map)) return;
  try {
    const built = buildWireframe(forms, wireframeOptions).closureSites;
    if (built === undefined) return;
    for (const [form, site] of built) emission.closureSites.set(form, site);
  } catch {
    // A program the wireframe refuses still runs. Its crossings share the root window.
  }
}
