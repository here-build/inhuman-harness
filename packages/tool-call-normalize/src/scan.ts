/**
 * Multi-pattern marker scanner (Aho-Corasick) — the FST host's lookahead
 * primitive.
 *
 * `normalize-stream.ts` currently answers "is there a tool-call marker
 * starting somewhere in this buffer, and could the tail still be growing
 * into one?" with `findOpenToolStart()` / `incompleteMarkerHold()`: an
 * O(markers × n) loop of `indexOf()` calls plus ad-hoc suffix-prefix checks.
 * That pairing is where the fence/hermes chunk-boundary corruption lives —
 * split-marker handling was bolted on separately from the "am I mid-marker"
 * question instead of falling out of one answer.
 *
 * Aho-Corasick gives both answers from the SAME automaton state in one O(n)
 * pass: the current node IS "how much of some marker am I currently inside"
 * (its trie depth), and the node's output set IS "did some marker just
 * complete" — no separate suffix-scanning pass, and a marker split across
 * ANY chunk boundary still matches because the automaton state carries the
 * partial match forward between `feed()` calls.
 *
 * This module is a pure, standalone scanner. It does not know about
 * dialects, spans, or the normalizer's hold/paint decision — it only
 * answers the two questions above. Wiring it into `normalize-stream.ts` is
 * a later task.
 */

/** A marker that fully matched inside the cumulative fed input. */
export type MarkerMatch = {
  /** The marker string, exactly as passed to `compileMarkers`/`createMarkerScanner`. */
  marker: string;
  /** Absolute start offset (inclusive) into the cumulative fed input. */
  start: number;
  /** Absolute end offset (exclusive) into the cumulative fed input. */
  end: number;
};

export type ScanState = {
  /**
   * The first marker match found since this scanner was created (or last
   * `reset()`), or `null` if none yet. A held span is a bet that resolves
   * exactly once: as soon as `match` is set, the scanner stops advancing
   * its automaton state — it is a resolved bet, not a search for a
   * "better" (differently-positioned) match. Callers that want to keep
   * scanning past a resolved match create a fresh scanner (or `reset()`)
   * for the remainder.
   *
   * When more than one marker completes at the exact same end offset
   * (e.g. "ab" and "abc" both matching text ending at the same point
   * because one is a prefix of the other), the longest — equivalently,
   * earliest-starting — marker wins.
   */
  match: MarkerMatch | null;
  /**
   * Length of the longest proper suffix of everything fed so far that is
   * a prefix of some marker — the bounded-hold amount. Every character
   * before this tail is provably not part of any still-incomplete marker
   * attempt and is safe to paint immediately. Always `0` once `match` is
   * non-null (the bet is resolved; there is nothing left to hold for).
   */
  holdLength: number;
};

/** Case-insensitive Aho-Corasick automaton over a fixed marker set. Build once, scan many times via `createScanner`. */
export type MarkerAutomaton = {
  readonly patterns: readonly string[];
};

type TrieNode = {
  /** Outgoing transitions, keyed by lowercase character. */
  children: Map<string, number>;
  /** Failure link: index of the node for the longest proper suffix of this node's string that is also a trie prefix. */
  fail: number;
  /** Depth from root = length of the string this node represents. */
  depth: number;
  /** Index into `patterns` this node terminates exactly, or -1. */
  end: number;
  /** Longest pattern (by index into `patterns`) that is a suffix of this node's string and IS a registered marker — own `end` if set, else inherited via `fail`. -1 if none. */
  output: number;
};

type CompiledAutomaton = MarkerAutomaton & {
  readonly nodes: readonly TrieNode[];
};

function newNode(depth: number): TrieNode {
  return { children: new Map(), fail: 0, depth, end: -1, output: -1 };
}

/**
 * Build the automaton once for a fixed marker set. Matching is
 * case-insensitive: markers are lowercased for trie construction, and
 * `createScanner`/`feed` lowercase input the same way before stepping.
 * `MarkerMatch.marker` still reports the marker in its original casing.
 */
export function compileMarkers(markers: string[]): MarkerAutomaton {
  if (markers.some((m) => m.length === 0)) {
    throw new Error("compileMarkers: markers must be non-empty strings");
  }
  const nodes: TrieNode[] = [newNode(0)];

  for (const [mi, marker] of markers.entries()) {
    const lower = marker!.toLowerCase();
    let cur = 0;
    for (const ch of lower) {
      let next = nodes[cur]!.children.get(ch);
      if (next === undefined) {
        next = nodes.length;
        nodes.push(newNode(nodes[cur]!.depth + 1));
        nodes[cur]!.children.set(ch, next);
      }
      cur = next;
    }
    // First pattern to reach this node claims `end`; duplicate marker
    // strings are equivalent for matching purposes, so it does not matter
    // which duplicate index wins.
    if (nodes[cur]!.end === -1) nodes[cur]!.end = mi;
  }

  // BFS to compute fail links and output (standard Aho-Corasick closure).
  const queue: number[] = [];
  for (const [, child] of nodes[0]!.children) {
    nodes[child]!.fail = 0;
    queue.push(child);
  }
  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++]!;
    nodes[u]!.output = nodes[u]!.end === -1 ? nodes[nodes[u]!.fail]!.output : nodes[u]!.end;
    for (const [ch, v] of nodes[u]!.children) {
      let f = nodes[u]!.fail;
      while (f !== 0 && !nodes[f]!.children.has(ch)) f = nodes[f]!.fail;
      const candidate = nodes[f]!.children.get(ch);
      nodes[v]!.fail = candidate !== undefined && candidate !== v ? candidate : 0;
      queue.push(v);
    }
  }

  const compiled: CompiledAutomaton = { patterns: [...markers], nodes };
  return compiled;
}

/** One transition step: follow fail links until a child for `ch` exists, or land on root. */
function step(nodes: readonly TrieNode[], cur: number, ch: string): number {
  let c = cur;
  while (c !== 0 && !nodes[c]!.children.has(ch)) {
    c = nodes[c]!.fail;
  }
  return nodes[c]!.children.get(ch) ?? 0;
}

export interface MarkerScanner {
  /**
   * Feed the next chunk of input. Absolute offsets in the returned
   * `ScanState.match` refer to the cumulative concatenation of every
   * chunk ever fed to this scanner (starting at 0), so a marker split
   * across this call's boundary and any prior chunk boundary still
   * resolves correctly.
   *
   * Once a match has been found, further `feed()` calls are no-ops as far
   * as matching goes (the automaton no longer advances) — `length` still
   * accumulates so callers can keep using it for offset bookkeeping, but
   * `match`/`holdLength` stay exactly as they were at match time.
   */
  feed(chunk: string): ScanState;
  /** Total number of characters ever passed to `feed()`, regardless of match state. */
  readonly length: number;
  /** Reset to the initial state (root, no match, length 0). Marker set is unchanged. */
  reset(): void;
}

/** Create a fresh streaming cursor over a compiled automaton. */
export function createScanner(automaton: MarkerAutomaton): MarkerScanner {
  const { nodes, patterns } = automaton as CompiledAutomaton;
  let cur = 0;
  let length = 0;
  let match: MarkerMatch | null = null;

  return {
    get length() {
      return length;
    },
    reset(): void {
      cur = 0;
      length = 0;
      match = null;
    },
    feed(chunk: string): ScanState {
      if (match !== null) {
        length += chunk.length;
        return { match, holdLength: 0 };
      }
      const base = length;
      const lower = chunk.toLowerCase();
      // `i` is a UTF-16 offset (`end = base + i + 1` must agree with
      // `chunk.length` / `marker.length`). Strings have no `.entries()`.

      for (let i = 0; i < lower.length; i++) {
        cur = step(nodes, cur, lower[i]!);
        const out = nodes[cur]!.output;
        if (out !== -1) {
          const end = base + i + 1;
          const marker = patterns[out]!;
          match = { marker, start: end - marker.length, end };
          length = base + chunk.length;
          return { match, holdLength: 0 };
        }
      }
      length = base + chunk.length;
      return { match: null, holdLength: nodes[cur]!.depth };
    },
  };
}

/** Convenience: `compileMarkers` + `createScanner` in one call. */
export function createMarkerScanner(markers: string[]): MarkerScanner {
  return createScanner(compileMarkers(markers));
}
