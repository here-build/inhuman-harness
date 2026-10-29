/**
 * scope-dag — the materialized per-container DAG behind the blueprint render.
 *
 * The model gives us a region tree whose loops are `iterations: Region[][]` — N runtime
 * DAGs, one per pass. The render wants the AST-grounded view: ONE unified DAG per
 * container, every runtime instance of an `(infer …)` call FOLDED onto a single node
 * keyed by its structural scope (`head@line:col`). The boundary ports already merge by
 * that key (trace-to-regions `RegionPort`); this extends the same fold from the boundary
 * to the INTERIOR.
 *
 * Why fold by scope: stacking, fan-out, and loop-recognition all become topology, not
 * heuristics. A producer that feeds two consumers has out-degree 2 in its container's
 * DAG — it CANNOT be a stack interior, so it stays a wired sibling (no value-equality
 * guessing). And the only cyclic edges after the fold are tail re-entries — `A→A` for
 * direct TCO, `A→B`/`B→A` for tick-tack mutual recursion — identified structurally by an
 * edge crossing from an earlier pass of the container to a later one. Lift those to the
 * container boundary (the frame's loop-back arc) and the interior is acyclic for every
 * loop shape. One rule — "fold by scope, lift re-entries" — subsumes the whole taxonomy.
 *
 * Pure: no DOM, no ELK. `iterations` is not discarded — it's the source we fold here and
 * the values the per-node iterator navigates downstream (a folded node carries its N
 * runtime instances, iteration-ordered).
 */
import type { Region, RegionGraph } from "@here.build/arrival-provenance";

/** A folded interior node: one AST site, every runtime instance that ran there. */
export interface ScopeNode {
  /** The merge key within a container — a leaf `scope` (`head@line:col`), a
   *  nested container marker (`#c<scope>`), or the statement output (`#out<id>`). */
  key: string;
  kind: "leaf" | "container" | "output";
  /** The N runtime regions folded onto this node, iteration-ordered. One for a root
   *  node; many for a node inside a loop (the per-card iterator steps through them). For
   *  a nested-container node this is the single fanout region. */
  instances: Region[];
}

/** One container's unified DAG. Root container is keyed `""`; each fanout opens a
 *  container keyed by its structural SCOPE PATH — the `▸`-joined chain of enclosing fanout
 *  scopes (so all its runtime passes fold together, not apart — the matryoshka fix — while
 *  two DIFFERENT instantiations of the same source-level map, e.g. a seed `evaluate` at root
 *  and the re-`evaluate` inside a loop's propose map, stay SEPARATE: same scope, different
 *  path. Bare-scope keying folded those two into one dag, emptying the in-loop frame onto
 *  the seed frame's cards — the real-gepa phantom map). */
export interface ScopeDag {
  /** `""` for the root container; `<scope>` for a root-level fanout body;
   *  `<outer scope>▸…▸<scope>` for a nested one. No iteration indices — passes fold. */
  container: string;
  nodes: Map<string, ScopeNode>;
  /** The container's ONE ordered body — its nodes in body order (first-instance
   *  appearance). The fold collapses N iterations onto one node per scope, but the
   *  emission order of a single pass is preserved here. Folding iterations and keeping
   *  the per-pass order are orthogonal — the fold is over runtime instances, the order
   *  is over scopes. */
  order: ScopeNode[];
  /** Interior dataflow (same-pass), scope-keyed and deduped across iterations. */
  dataEdges: ScopeEdge[];
  /** Tail re-entries lifted to the boundary — an edge from an earlier pass of THIS
   *  container to a later one (the loop-back arc). `A→A` direct, `A→B` tick-tack. */
  reentry: ScopeEdge[];
}

export interface ScopeEdge {
  from: string;
  to: string;
  field?: string;
  fromField?: string;
}

const containerKey = (scope: string): string => `#c${scope}`;
const outputKey = (id: number): string => `#out${id}`;

/** The merge key of a region within its immediate container. A fanout keys by its
 *  structural `scope`, NOT its runtime `id`: a nested `(map …)` run once per outer pass
 *  gets a fresh `id` each time, so id-keying would scatter it into N un-merged container
 *  nodes (the matryoshka bug). Scope folds all those passes onto one container. */
function nodeKey(r: Region): string {
  if (r.kind === "leaf") return r.scope;
  if (r.kind === "fanout") return containerKey(r.scope);
  return outputKey(r.id);
}

function nodeKind(r: Region): ScopeNode["kind"] {
  if (r.kind === "fanout") return "container";
  if (r.kind === "leaf") return "leaf";
  return "output";
}

/** The scope-path key of a child container opened inside `parent` by a fanout of scope
 *  `scope` — the DAG identity. Root children keep the bare scope (byte-compatible with the
 *  old bare-scope keys at root level); nested ones accumulate the chain. */
export const childContainerKey = (parent: string, scope: string): string =>
  parent === "" ? scope : `${parent}▸${scope}`;

/** One step of a region's enclosing-container chain: which container (bare scope — the
 *  node-key component), its cumulative scope-path `key` (the DAG identity), and which of
 *  its iteration bodies the region sits in. Root step is `{scope:"", key:"", iter:0}`. */
interface PathStep {
  scope: string;
  key: string;
  iter: number;
}

interface RegionIndex {
  byId: Map<number, Region>;
  /** id → enclosing-container chain (outermost→innermost; last entry is the region's
   *  immediate container). The shared prefix of two chains is their common containers. */
  pathOf: Map<number, PathStep[]>;
  /** id → its immediate container's scope-path key (`""`, `<scope>`, or `<…>▸<scope>`). */
  homeOf: Map<number, string>;
}

function indexRegions(graph: RegionGraph): RegionIndex {
  const byId = new Map<number, Region>();
  const pathOf = new Map<number, PathStep[]>();
  const homeOf = new Map<number, string>();
  const walk = (regions: readonly Region[], path: PathStep[]): void => {
    const container = path[path.length - 1].key;
    for (const r of regions) {
      byId.set(r.id, r);
      pathOf.set(r.id, path);
      homeOf.set(r.id, container);
      if (r.kind === "fanout")
        for (const [i, body] of r.iterations.entries())
          walk(body, [...path, { scope: r.scope, key: childContainerKey(container, r.scope), iter: i }]);
    }
  };
  walk(graph.roots, [{ scope: "", key: "", iter: 0 }]);
  return { byId, pathOf, homeOf };
}

/** Project an edge endpoint (a runtime invocation id) into container `C`'s node space.
 *  Returns the interior node key, or null when the endpoint lives outside `C` (then the
 *  edge is a boundary crossing for `C`, handled by ports, not an interior edge).
 *  - endpoint directly in `C` → its own `nodeKey`
 *  - endpoint inside a nested fanout that is a child of `C` → that fanout's container node */
function project(id: number, container: string, idx: RegionIndex): string | null {
  const path = idx.pathOf.get(id);
  const r = idx.byId.get(id);
  if (!path || !r) return null;
  const i = path.findIndex((s) => s.key === container);
  if (i === -1) return null; // endpoint external to C
  if (i === path.length - 1) return nodeKey(r); // immediate child of C
  return containerKey(path[i + 1].scope); // sits inside C's child fanout — its NODE key is the bare scope
}

/** Which iteration body of container `C` an endpoint sits in (0 for the root container). */
function iterWithin(id: number, container: string, idx: RegionIndex): number {
  const step = idx.pathOf.get(id)?.find((s) => s.key === container);
  return step?.iter ?? 0;
}

/**
 * Fold a region graph into one `ScopeDag` per container. The model is untouched — this is
 * a pure render-time projection over the trace's own provenance.
 */
export function buildScopeDags(graph: RegionGraph): Map<string, ScopeDag> {
  const idx = indexRegions(graph);
  const dags = new Map<string, ScopeDag>();
  const dagFor = (container: string): ScopeDag => {
    let d = dags.get(container);
    if (!d) dags.set(container, (d = { container, nodes: new Map(), order: [], dataEdges: [], reentry: [] }));
    return d;
  };
  // Root container always exists (even an empty trace renders an empty root DAG).
  dagFor("");

  // NODES — fold every region onto its container's node keyed by structural scope.
  for (const [id, container] of idx.homeOf) {
    const r = idx.byId.get(id)!;
    const dag = dagFor(container);
    const key = nodeKey(r);
    let node = dag.nodes.get(key);
    if (!node) {
      // First appearance in this container — record body order. `idx.homeOf` is a
      // pre-order DFS, so newly-seen keys arrive in emission order.
      node = { key, kind: nodeKind(r), instances: [] };
      dag.nodes.set(key, node);
      dag.order.push(node);
    }
    node.instances.push(r);
    // A fanout also OPENS its own container — make sure that DAG exists even if its body
    // carried no foldable edges (so the render can still draw the empty loop frame).
    if (r.kind === "fanout") dagFor(childContainerKey(container, r.scope));
  }
  for (const dag of dags.values())
    for (const node of dag.nodes.values())
      node.instances.sort(
        (a, b) => iterWithin(a.id, dag.container, idx) - iterWithin(b.id, dag.container, idx) || a.id - b.id,
      );

  // EDGES — an edge is interior to every container in the shared prefix of its endpoints'
  // chains (their common ancestors). In each such container, project both ends, then split
  // interior-vs-reentry by whether the value crosses from an earlier pass to a later one.
  const seen = new Map<string, Set<string>>(); // container → deduped "(data|re)|from|to|field|fromField"
  const dedupe = (container: string, k: string): boolean => {
    const s = seen.get(container) ?? seen.set(container, new Set()).get(container)!;
    if (s.has(k)) return true;
    s.add(k);
    return false;
  };
  for (const e of graph.edges) {
    const fromPath = idx.pathOf.get(e.from);
    const toPath = idx.pathOf.get(e.to);
    if (!fromPath || !toPath) continue;
    const depth = Math.min(fromPath.length, toPath.length);
    for (let i = 0; i < depth; i++) {
      if (fromPath[i].key !== toPath[i].key) break; // shared prefix ended
      const container = fromPath[i].key;
      const fromK = project(e.from, container, idx);
      const toK = project(e.to, container, idx);
      if (fromK === null || toK === null) continue;
      const dag = dagFor(container);
      const iF = iterWithin(e.from, container, idx);
      const iT = iterWithin(e.to, container, idx);
      const edge: ScopeEdge = { from: fromK, to: toK, field: e.field, fromField: e.fromField };
      if (iT > iF) {
        if (!dedupe(container, `re|${fromK}|${toK}|${e.field ?? ""}|${e.fromField ?? ""}`)) dag.reentry.push(edge);
      } else if (fromK !== toK && !dedupe(container, `data|${fromK}|${toK}|${e.field ?? ""}|${e.fromField ?? ""}`))
        dag.dataEdges.push(edge);
      // fromK === toK within the same pass is a degenerate self-loop — dropped.
    }
  }
  return dags;
}

/** A maximal linear chain of the interior data DAG: nodes that stack on one line because
 *  the flow runs through them single-file. `members` is in dataflow order (producer →
 *  consumer); the SINK (last member) is the one the layout places, and each earlier member
 *  renders absorbed inside the next's field row (the matryoshka density). `edges` are the
 *  contracted hops, carrying the `field`/`fromField` the absorbed producer landed in. */
export interface Stack {
  members: string[];
  edges: ScopeEdge[];
}

/**
 * Stacking as a topology theorem, not a heuristic. A stack is a maximal simple path over
 * `dag.dataEdges` whose every INTERIOR vertex has in-degree 1 AND out-degree 1 — i.e. each
 * hop `a→b` is stackable exactly when `a` has a single consumer and `b` a single producer.
 *
 * This is what dissolves the matryoshka bug as a corollary: a producer that feeds two
 * consumers has out-degree 2, so no hop out of it is stackable — it can never be a stack
 * interior, and stays a wired sibling with BOTH wires drawn (the old value-equality
 * `planNesting` buried the second wire by absorbing the producer at its first field). A
 * merge vertex (in-degree > 1) terminates a stack on the consumer side for the same reason.
 *
 * Pure degree arithmetic over the already-deduped, scope-keyed edges. Stackable hops form
 * vertex-disjoint simple paths automatically (interior in==out==1), so contracting them
 * needs no cycle guard — a fold that reached itself would force some interior degree > 1.
 */
export function stacksOf(dag: ScopeDag): Stack[] {
  const outdeg = new Map<string, number>();
  const indeg = new Map<string, number>();
  for (const e of dag.dataEdges) {
    outdeg.set(e.from, (outdeg.get(e.from) ?? 0) + 1);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const stackable = dag.dataEdges.filter((e) => outdeg.get(e.from) === 1 && indeg.get(e.to) === 1);
  // Each stackable hop is the unique out-edge of its source and unique in-edge of its
  // target, so `next`/`prev` are functions — the contraction is just "walk from each chain
  // head to its tail".
  const next = new Map<string, ScopeEdge>(stackable.map((e) => [e.from, e]));
  const hasIncoming = new Set(stackable.map((e) => e.to));
  const stacks: Stack[] = [];
  for (const e of stackable) {
    if (hasIncoming.has(e.from)) continue; // not a chain head — visited from upstream
    const members = [e.from];
    const edges: ScopeEdge[] = [];
    for (let hop: ScopeEdge | undefined = e; hop; hop = next.get(hop.to)) {
      members.push(hop.to);
      edges.push(hop);
    }
    stacks.push({ members, edges });
  }
  return stacks;
}
