/**
 * region-elk-layout — lays out the blueprint's REGION tree (arrival-chain's
 * `RegionGraph`) into positioned cards + frames, in causal left→right layers, via
 * the shared lazy ELK engine (`./elk`). The blueprint used to flow nodes
 * in a wrapping flex row (no causal order, wires crossing arbitrarily); this gives
 * it the same layered geometry the flowchart has, while keeping the region tree's
 * card / Z-tab character.
 *
 * The ONE rule that keeps it cheap — the Z-tab IS the collapse:
 *   A fanout (`map`/`filter`/TCO `loop`/…) shows ONE iteration at a time (the
 *   selected tab). Only that iteration's regions are emitted to ELK; the other
 *   iterations never mount (a 1000-iteration loop is ONE body + a tab strip, not
 *   1000 subtrees laid out). Flipping a tab re-lays-out just the now-visible body.
 *
 * Edges (`graph.edges`, producer→consumer between leaf invocation ids) re-point to
 * the nearest VISIBLE ancestor — an edge into a leaf hidden behind another tab
 * lifts to the fanout frame, so region→region causality stays drawn at every tab
 * selection (the flowchart's rule 2, applied to Z-tabs instead of fold state).
 *
 * The graph is the CAUSAL one (`./causal`): no decision regions, no control edges — every
 * edge is dataflow, and every edge lands in exactly one `WireAudit` bucket.
 *
 * Sizes come from the renderer's own DOM measurement (cards are content-sized and
 * stream, so they can't be fixed up front like the flowchart's): `sizeOf(id)`
 * returns a measured rect, falling back to a default until the first measure. Width
 * is bounded (cards `maxWidth`), so measure→layout→measure settles in one pass.
 */
import type { Region, RegionGraph } from "@here.build/arrival-provenance";

import { type ElkEngine, type ElkNode, getElk, LAYERED_ROOT_OPTIONS } from "./elk.js";
import { fanoutOrder, mergedFanout } from "./iteration-flow.js";
import { buildScopeDags, childContainerKey, type ScopeNode } from "./scope-dag.js";

/** Default card footprint before the first DOM measure (a leaf that hasn't been
 *  mounted-and-measured yet). Real measured sizes replace these. */
const DEFAULT_CARD_W = 220;
const DEFAULT_CARD_H = 92;
/** Frame insets: extra room at the top for the fanout's label + Z-tab strip. */
const FRAME_PAD_TOP = 46;
const FRAME_PAD = 12;
/** A MERGED (single-node) fanout's top inset — just the header band's height plus a hair,
 *  so the label+tabs sit flush on the one child with no surrounding box. */
const MERGE_PAD_TOP = 26;

/** Readability dials, applied to BOTH the root graph and every fanout frame —
 *  `SEPARATE_CHILDREN` lays each frame out as its own sub-graph, so root options do
 *  NOT cascade into child frames. The `evolve` steps live inside fanout frames
 *  (the TCO recursion loop), so the per-frame spread is the load-bearing one. */
const READABILITY_OPTIONS: Record<string, string> = {
  // Manhattan wires: elbowed segments read as fewer crossings, and parallel wires
  // stop overlapping diagonally.
  "elk.edgeRouting": "ORTHOGONAL",
  // Brandes-Köpf placement with straight-edge bias: when a producer feeds a single
  // consumer, BK pulls them onto the SAME horizontal line so the wire runs straight
  // (V's "move decide.prompt down and both lines go straight"). NETWORK_SIMPLEX
  // compacts vertically but doesn't bias toward straightness the way BK does.
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  // Let crossing-min REORDER nodes freely (no semiInteractive position-respecting),
  // and sweep harder than the single default pass so it actually finds the order that
  // un-crosses the analyze/decide → evolve wires.
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.thoroughness": "30",
  // Orthogonal wires need elbow room so parallel segments don't fuse.
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeNode": "16",
};

export interface PositionedRegion {
  region: Region;
  /** The folded runtime regions this node stands for, iteration-ordered — the N
   *  instances of one `(infer …)` call across a loop's passes (`region` is `[0]`, the
   *  representative). One entry for a root-level node; many inside a loop body. A LATER
   *  step picks the value to show by tab index from this; here it's carried-through so the
   *  fold's union node set keeps every instance addressable. Absent for a node with no
   *  ScopeDag backing. */
  instances?: Region[];
  /** Position relative to parent frame (the renderer folds in parent offsets). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A leaf card (true) vs. an open fanout frame (false). */
  isLeaf: boolean;
  parentId: number | null;
}

/** A wire terminal: either a CARD (a leaf — docks at its result block on the
 *  producer side, or an input-field row on the consumer side) or a container
 *  boundary PORT (a slot on a frame's right `out` edge or left `in` edge). */
export type WireEnd =
  { kind: "card"; id: number; field?: string } | { kind: "port"; frame: number; side: "in" | "out"; slot: number };

/** One drawn wire segment between two terminals, tagged with the ORIGINATING
 *  producer (`entity`) so a renderer can colour/trace a whole route. A wire that
 *  crosses container boundaries is several segments sharing one `entity`. */
export interface WireSegment {
  from: WireEnd;
  to: WireEnd;
  entity: number;
  /** How many ADDITIONAL edges folded onto this route beyond the drawn one (per-pass /
   *  per-element duplicates the scope-fold collapsed). Set on the route's TERMINAL segment
   *  (the consumer-entry hop); the view badges it `×(1+folds)`. 0 = the wire is itself. */
  folds: number;
  /** GHOST — no edge realized under the current Z-tab selection travels this hop; the flow
   *  exists only in OTHER iterations (a divergent route). Rendered as disappearing
   *  spaghetti (fading stroke), never dashed/badged. A hop shared with a realized edge is
   *  solid (realized edges are routed first). */
  ghost: boolean;
  /** GHOST NAVIGATION — the Z-tab selections that REALIZE this hop: every (fanout id →
   *  iteration) coordinate of the ghost edge's endpoints that disagrees with the current
   *  selection. Clicking the ghost applies them and the route turns solid. Set only on
   *  ghost segments (from the FIRST ghost edge that drew the hop). */
  goto?: [number, number][];
}

/** Every edge's rendering FATE — the wire conservation law. "Dropped" is not a member:
 *  each graph edge must land in exactly one bucket, and `unaccounted` (an edge no rule
 *  claimed) is a BUG the audit surfaces loudly. A new degenerate case is added here as
 *  yet another materialization kind, never as a silent filter. */
export interface WireAudit {
  /** Drawn as (at least one new) wire segment. */
  wire: number;
  /** A per-pass duplicate of an already-drawn wire (same folded route) — that wire represents it. */
  folded: number;
  /** Cross-iteration (loop-carried) — rides the TCO loop-back contour; its port is recursion-served. */
  loopback: number;
  /** Realized only in OTHER iterations, on a route no realized edge shares — drawn as the
   *  disappearing GHOST wire ("goes a different way in other iterations"). */
  ghost: number;
  /** Both endpoints fold/lift into ONE visible node — the node's interior renders the flow. */
  containment: number;
  /** No rule claimed it — a silent drop. MUST stay 0; the audit test enforces it. */
  unaccounted: number;
}

export interface RegionLayout {
  nodes: PositionedRegion[];
  /** Dormant boundary crossings — a union port (some iteration uses it) with NO edge in
   *  the CURRENT projection. The view draws each as a short stub ending at the frame edge:
   *  the flow is present-but-unused on this iteration (the shape-with-voids), so the
   *  joint set stays stable across tab switches instead of appearing/vanishing. */
  stubs: { frame: number; side: "in" | "out"; slot: number; producer: string }[];
  /** Boundary-routed dataflow wires. A producer→consumer wire that crosses a
   *  container edge is BROKEN at that edge into a port: the value exits each
   *  enclosing container through a right-edge slot and enters each target container
   *  through a left-edge slot. Ports are keyed by the originating producer, so every
   *  consumer of one value shares a single slot (multi-consumer fan-out). */
  segments: WireSegment[];
  /** Per-edge fate accounting over the INPUT graph — Σ buckets === graph.edges.length. */
  wireAudit: WireAudit;
}

/** A measured rect for a leaf card, or undefined to use the default footprint. */
export type SizeOf = (id: number) => { width: number; height: number } | undefined;

/** A collapsed fanout's slot pitch + top inset, matched to the renderer's port grid
 *  (the view's port top/step) so the box is tall enough to hold every rail. */
const COLLAPSED_PORT_TOP = 48;
const COLLAPSED_PORT_STEP = 12;
const COLLAPSED_MIN_W = 160;
const COLLAPSED_MAX_W = 280;

export async function regionElkLayout(
  graph: RegionGraph,
  /** fanout id → selected iteration index (the active Z-tab). Absent ⇒ tab 0. */
  selTabs: Map<number, number>,
  sizeOf: SizeOf,
  /** fanout ids drawn COLLAPSED — a hermetic box reduced to its boundary port rails,
   *  no internals emitted (its children never enter `visible`, so every edge into/out
   *  of it lifts to its ports exactly as an all-tabs-hidden frame would). Absent ⇒ all
   *  expanded (the working render is unchanged when nothing is collapsed). */
  collapsed?: ReadonlySet<number>,
  engine?: ElkEngine,
): Promise<RegionLayout> {
  // Full parent index over EVERY region (all iterations) — needed to lift an edge
  // whose endpoint sits in a hidden tab up to its visible frame.
  const fullParent = new Map<number, number | null>();
  const byId = new Map<number, Region>();
  const indexAll = (r: Region, parentId: number | null): void => {
    fullParent.set(r.id, parentId);
    byId.set(r.id, r);
    if (r.kind === "fanout") for (const iter of r.iterations) for (const c of iter) indexAll(c, r.id);
  };
  for (const r of graph.roots) indexAll(r, null);

  // Iteration membership: region id → (enclosing fanout id → which iteration index it sits in).
  // A loop/map carries N passes as `iterations[k]`; an edge whose two endpoints sit in DIFFERENT
  // iterations of a COMMON fanout is CROSS-ITERATION (the loop-carried back-edge — reflect(pass N)
  // → react(pass N+1)). Folded onto the visible pass it would draw as a spurious backward in-pass
  // wire; the recursion is instead conveyed by the TCO loop-back line around the block, so we drop
  // it from the data segments. Same-iteration edges (incl. crossing a fanout boundary within ONE
  // pass, like react→reflect) are kept.
  const iterOf = new Map<number, ReadonlyMap<number, number>>();
  const indexIters = (r: Region, ctx: ReadonlyMap<number, number>): void => {
    iterOf.set(r.id, ctx);
    if (r.kind === "fanout") {
      for (const [k, iter] of r.iterations.entries()) {
        const next = new Map(ctx).set(r.id, k);
        for (const c of iter) indexIters(c, next);
      }
    }
  };
  for (const r of graph.roots) indexIters(r, new Map());
  const crossIteration = (from: number, to: number): boolean => {
    const fi = iterOf.get(from);
    const ti = iterOf.get(to);
    if (!fi || !ti) return false;
    for (const [fanout, k] of fi) if (ti.has(fanout) && ti.get(fanout) !== k) return true;
    return false;
  };
  // Is this edge REALIZED under the current Z-tab selection — i.e. does every iteration
  // coordinate on either endpoint agree with its fanout's selected tab? A folded wire is
  // otherwise a lie of aggregation (the union of ALL passes drawn solid): an edge whose
  // flow happened only in OTHER iterations must not read as this pass's dataflow. Where
  // its route diverges from every realized route it renders as a GHOST — the disappearing
  // wire that says "this goes a different way in other iterations; flip the tab".
  const selOf = (fanoutId: number): number => {
    const fr = byId.get(fanoutId);
    const len = fr?.kind === "fanout" ? fr.iterations.length : 1;
    return Math.min(selTabs.get(fanoutId) ?? 0, Math.max(0, len - 1));
  };
  const realizedNow = (from: number, to: number): boolean => {
    for (const coords of [iterOf.get(from), iterOf.get(to)]) {
      if (!coords) continue;
      for (const [fanout, k] of coords) if (k !== selOf(fanout)) return false;
    }
    return true;
  };
  /** GHOST NAVIGATION — the selection delta that REALIZES a ghost edge: every endpoint
   *  coordinate disagreeing with the current tabs. Clicking the ghost applies these and
   *  the divergent route becomes the selected pass. */
  const gotoOf = (from: number, to: number): [number, number][] => {
    const delta = new Map<number, number>();
    for (const coords of [iterOf.get(from), iterOf.get(to)]) {
      if (!coords) continue;
      for (const [fanout, k] of coords) if (k !== selOf(fanout)) delta.set(fanout, k);
    }
    return [...delta];
  };

  // FOLD RUNTIME ITERATIONS ONTO AST-SCOPE IDENTITY. The model carries a loop as
  // `iterations: Region[][]` — N runtime passes, each with its OWN invocation ids. Laying
  // out only the selected pass meant pass-0's `analyze` leaf and pass-1's were DIFFERENT
  // ELK nodes, so switching the Z-tab handed ELK a brand-new graph and the layout JUMPED.
  // `buildScopeDags` folds every runtime instance of one `(infer …)` call onto ONE node
  // keyed by its structural scope (`head@line:col` — the same string every iteration), and
  // gives us, per container, the UNION of scopes across all passes. That union is the data
  // node set we lay out: stable regardless of `selTabs`, so a tab switch no longer changes
  // which nodes mount (a 1000-iter `map` still folds to ONE body — all passes share scopes).
  const dags = buildScopeDags(graph);
  // A region's structural key within its immediate container (mirrors scope-dag's `nodeKey`).
  const scopeKeyOf = (r: Region): string => {
    if (r.kind === "leaf") return r.scope;
    if (r.kind === "fanout") return `#c${r.scope}`;
    return `#out${r.id}`;
  };
  // A region's container key: the SCOPE PATH of its enclosing fanout chain (`""` at root).
  // Mirrors the ScopeDag container keys — path-keyed so a nested map's passes fold together
  // (iter indices excluded) while two different instantiations of the same source-level map
  // (seed evaluate at root vs re-evaluate inside a loop) resolve to SEPARATE dags. Walk the
  // `fullParent` chain collecting fanout scopes outermost→innermost.
  const homeKeyCache = new Map<number, string>();
  const homeKeyOf = (r: Region): string => {
    const hit = homeKeyCache.get(r.id);
    if (hit !== undefined) return hit;
    const scopes: string[] = [];
    for (let p = fullParent.get(r.id) ?? null; p !== null; p = fullParent.get(p) ?? null) {
      const pr = byId.get(p);
      if (pr?.kind === "fanout") scopes.unshift(pr.scope);
    }
    const key = scopes.reduce((acc, s) => childContainerKey(acc, s), "");
    homeKeyCache.set(r.id, key);
    return key;
  };
  /** The container a fanout OPENS — its own dag key (home path extended by its scope). */
  const openedKeyOf = (r: Region & { kind: "fanout" }): string => childContainerKey(homeKeyOf(r), r.scope);
  // Resolve any region (any iteration's instance) to its FOLDED ScopeNode — the union node
  // every pass of this call shares. `instances[0]` is the iteration-0 region: a STABLE
  // representative id, the same across tab switches, used as the ELK node id and the drawn
  // card terminal so identity is scope, not per-iteration invocation.
  const scopeNodeOf = (r: Region): ScopeNode | undefined => dags.get(homeKeyOf(r))?.nodes.get(scopeKeyOf(r));
  const reprOf = (r: Region): Region => scopeNodeOf(r)?.instances[0] ?? r;
  // The folded instances behind a representative id, for the PositionedRegion (a later step
  // picks the shown value by tab index). Keyed by representative id once built.
  const instancesById = new Map<number, Region[]>();

  // A folded node's parent is the VISIBLE frame it was emitted into, which need not be its
  // representative's own parent in the model: a nested fanout's passes fold onto the
  // outer pass-0 instance, and the frame on screen is the one the selected tab opens.
  // `parentOf` consults this overlay first; hidden regions (behind another Z-tab, never
  // emitted) fall through to `fullParent`.
  const frameParent = new Map<number, number | null>();
  const parentOf = (id: number): number | null =>
    frameParent.has(id) ? (frameParent.get(id) ?? null) : (fullParent.get(id) ?? null);

  // Build the ELK tree from the VISIBLE subtree (active tab of each fanout only).
  // Keep each created ElkNode addressable by id so edges can be hung on the frame
  // that contains BOTH endpoints (their LCA) — see edge distribution below.
  const visible = new Set<number>();
  const elkById = new Map<number, ElkNode>();
  // Build one container's children. The layout is FOLDED + stable: the node set is the union
  // of scope nodes across every pass (`containerKey` names the ScopeDag whose union we
  // draw). `selectedBody` is the chosen pass; its regions lead, each folded to its
  // representative, then any UNION node the selected pass omitted (mounted in a different
  // pass) is appended — so the node set is identical across tabs and only the order leads
  // with what ran on this one.
  const buildBody = (selectedBody: readonly Region[], parent: number | null, containerKey: string): ElkNode[] => {
    const built: ElkNode[] = [];
    const emit = (r: Region): void => {
      // Fold the emitted region onto its representative — the stable iteration-0 id, so a
      // tab switch keeps the same ELK node (and the same drawn card terminal).
      const repr = reprOf(r);
      // ONE ELK node per scope per container. The per-pass `selectedBody` can carry N runtime
      // instances of one `(infer …)` site (a prelude TCO loop — e.g. `index-map` — inlines
      // every iteration at this container instead of opening a fanout), and they all fold to
      // the SAME repr id. Emitting each one yields N ELK nodes sharing an id → duplicate React
      // keys downstream, so a scope already visible is skipped on both paths.
      if (visible.has(repr.id)) return;
      frameParent.set(repr.id, parent);
      built.push(buildElk(repr));
    };
    for (const r of selectedBody) emit(r);
    // `dag.order` is the folded body in first-appearance order.
    for (const node of dags.get(containerKey)?.order ?? []) emit(node.instances[0]!);
    return built;
  };
  // `r` here is always a REPRESENTATIVE (iteration-0) region — `buildBody` folds every
  // emitted region onto its scope node before reaching `buildElk`, so the ELK id and the
  // recorded instances key off the stable representative.
  const buildElk = (r: Region): ElkNode => {
    visible.add(r.id);
    const folded = scopeNodeOf(r)?.instances;
    if (folded) instancesById.set(r.id, folded);
    if (r.kind !== "fanout") {
      const s = sizeOf(r.id);
      const node: ElkNode = {
        id: String(r.id),
        width: s?.width ?? DEFAULT_CARD_W,
        height: s?.height ?? DEFAULT_CARD_H,
      };
      elkById.set(r.id, node);
      return node;
    }
    // COLLAPSED (Stage 2c — hermetic box): emit a childless node sized to its port
    // rails. The body is NOT visited, so its leaves never join `visible` and every
    // dataflow into/out of it lifts to this frame's entrance/exit ports — the same
    // path a hidden Z-tab takes. The box just needs to be tall enough for the rails.
    if (collapsed?.has(r.id)) {
      const rails = Math.max(r.inputs.length, r.outputs.length, 1);
      const crumb = fanoutOrder(r);
      const node: ElkNode = {
        id: String(r.id),
        width: Math.min(COLLAPSED_MAX_W, Math.max(COLLAPSED_MIN_W, Math.round(crumb.length * 7 + 56))),
        height: COLLAPSED_PORT_TOP + rails * COLLAPSED_PORT_STEP + FRAME_PAD,
      };
      elkById.set(r.id, node);
      return node;
    }
    const sel = Math.min(selTabs.get(r.id) ?? 0, Math.max(0, r.iterations.length - 1));
    // A single-node fanout MERGES: the label+tabs become a hat on the one child, so the
    // frame hugs it — header band on top, zero side/bottom inset (no surrounding box).
    const merged = mergedFanout(r);
    // Data folds to this fanout's union (its scope-PATH container in the dags); the selected
    // pass only leads the order.
    const children = buildBody(r.iterations[sel] ?? [], r.id, openedKeyOf(r));
    const node: ElkNode = {
      id: String(r.id),
      layoutOptions: {
        ...READABILITY_OPTIONS,
        "elk.padding": merged
          ? `[top=${MERGE_PAD_TOP},left=0,bottom=0,right=0]`
          : `[top=${FRAME_PAD_TOP},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`,
        "elk.direction": "RIGHT",
      },
      children,
    };
    // EMPTY VISIBLE BODY ⇒ SIZED STUB, never a 0×0 point. Historically a fanout's whole
    // interior could fold away when the SAME call-site scope was instantiated in two home
    // containers (GEPA's seed-vs-in-loop `evaluate`) — scope-PATH container keys now keep
    // those twins separate, so that case is gone; this guard remains for any genuinely
    // empty visible body (e.g. every leaf behind other Z-tabs). ELK sizes a childless
    // non-collapsed node to 0×0, and a zero-size frame still occupies a layer + edge
    // endpoint — smearing its siblings onto a diagonal. Give it the labeled-box footprint
    // a collapsed frame gets, so it reads as present-but-folded (shape-with-voids).
    if (children.length === 0) {
      const rails = Math.max(r.inputs.length, r.outputs.length, 1);
      const crumb = fanoutOrder(r);
      node.width = Math.min(COLLAPSED_MAX_W, Math.max(COLLAPSED_MIN_W, Math.round(crumb.length * 7 + 56)));
      node.height = COLLAPSED_PORT_TOP + rails * COLLAPSED_PORT_STEP + FRAME_PAD;
    }
    elkById.set(r.id, node);
    return node;
  };
  const roots = buildBody(graph.roots, null, "");

  // REGION ISOLATION. With `SEPARATE_CHILDREN` (below) ELK lays out each frame's
  // contents in its OWN sub-layout — many small graphs, not one global hierarchy —
  // which is the whole speed win. The price: an edge only lays out when its two
  // endpoints are SIBLINGS (share a parent frame). So every edge is resolved to the
  // children of its endpoints' lowest common visible ancestor: a wire between two
  // leaves in different regions becomes a region→region wire at the level where
  // those regions ARE siblings.
  //
  // First, climb a hidden endpoint (sitting behind another Z-tab) to its nearest
  // VISIBLE ancestor; then find the common level.
  const visParent = (id: number): number | null => {
    let cur = parentOf(id);
    while (cur !== null && !visible.has(cur)) cur = parentOf(cur);
    return cur;
  };
  const liftToVisible = (id: number): number | null => {
    let cur: number | null = id;
    while (cur !== null && !visible.has(cur)) cur = parentOf(cur);
    return cur;
  };
  /** Visible ancestor chain [self, parent, …, root]. */
  const chainToRoot = (id: number): number[] => {
    const chain: number[] = [];
    for (let cur: number | null = id; cur !== null; cur = visParent(cur)) chain.push(cur);
    return chain;
  };
  // Each resolved edge connects two SIBLINGS, so it's laid out by their shared
  // parent frame's sub-layout. With `SEPARATE_CHILDREN` an edge only steers node
  // ordering if it lives on the LCA node itself (root edges can't reach inside an
  // isolated frame). So we hang every edge on `visParent(from)` — the frame that
  // owns both endpoints — and only fall back to the root's edge list when the pair
  // is top-level. This is what makes the IN-CONTAINER dataflow visible: an `A→B`
  // between two leaves inside a loop body now orders those leaves left→right.
  const rootEdges: { id: string; sources: string[]; targets: string[] }[] = [];
  const edgesFor = (containerId: number | null): { id: string; sources: string[]; targets: string[] }[] => {
    if (containerId === null) return rootEdges;
    const node = elkById.get(containerId)!;
    return (node.edges ??= []) as { id: string; sources: string[]; targets: string[] }[];
  };
  // Is `a` a VISIBLE ancestor of `b`? Used to skip a containment wire (a frame to a
  // node inside it) — those belong to the region-input/output ports, not spaghetti.
  const isVisAncestor = (a: number, b: number): boolean => {
    for (let cur = visParent(b); cur !== null; cur = visParent(cur)) if (cur === a) return true;
    return false;
  };
  // TWO edge products, because ELK ordering and the drawn wire want different shapes:
  //
  //  - ELK ORDERING (`rootEdges` / per-frame `.edges`): under `SEPARATE_CHILDREN`
  //    an edge only steers layout if its endpoints are SIBLINGS, so it's lifted to
  //    the children of their LCA frame and hung on that frame. This is what orders
  //    leaves left→right inside a container; it is NOT what gets painted.
  //  - DRAWN WIRES (`segments`): the spaghetti the user sees, BROKEN at every
  //    container boundary it crosses. Going up from the producer, the value EXITS
  //    each enclosing container through a right-edge port; coming down to the
  //    consumer it ENTERS each target container through a left-edge port. Ports are
  //    keyed by the originating producer (`e.from`), so all consumers of one value
  //    share a single slot — and the 1 slot a container has today becomes N when
  //    structured-output provenance splits a producer into per-field entities. An
  //    endpoint hidden behind a Z-tab lifts to its frame: a hidden producer's value
  //    simply emerges from that frame's exit port; a hidden consumer's wire stops at
  //    the frame's entrance port.
  // A "card" terminal for wiring: a producer leaf or the program's output node — both dock
  // at a placed node, not a container boundary port.
  const isLeafId = (id: number): boolean => {
    const k = byId.get(id)?.kind;
    return k === "leaf" || k === "output";
  };
  // A boundary port propagates ONE DATAFLOW, not one value. A `map`/loop body that
  // runs N times has N concrete producer leaves for what is structurally a single
  // `(infer …)` call — same `scope` (`head@line:col`). Keying a frame's port slots by
  // the producer's SCOPE (not its per-iteration invocation id) collapses those N value
  // wires into one dataflow port; distinct producers inside the container still get
  // distinct slots, and the 1 slot a producer has today still becomes N when
  // structured-output provenance splits it per field.
  const scopeOf = (id: number): string => {
    const r = byId.get(id);
    return r?.kind === "leaf" ? r.scope : String(id);
  };
  const exitPorts = new Map<number, string[]>(); // frame → producer scopes; slot = index
  const entrancePorts = new Map<number, string[]>();
  // SEED each container's port slots from its DECLARED boundary ports (Stage 2 —
  // regions ARE boxes). The region now carries `inputs`/`outputs` as first-class,
  // scope-keyed, canonically-sorted data; seeding the slot tables from them gives
  // every frame a STABLE port order — independent of edge-iteration order and of
  // which Z-tab is selected — and lets a collapsed frame draw exactly these ports
  // (2c). The per-edge routing below then finds each producer's slot already
  // assigned (an `indexOf` hit); a crossing the model didn't predict still appends
  // after, so nothing is lost.
  // `?? []` — a region graph built outside `traceToRegions` (a hand-constructed test
  // fixture, a future producer) may not carry declared ports; seeding is an ordering
  // optimization, so its absence just means the per-edge routing assigns every slot.
  for (const r of byId.values()) {
    if (r.kind !== "fanout") continue;
    entrancePorts.set(
      r.id,
      r.inputs.map((p) => p.producer),
    );
    exitPorts.set(
      r.id,
      r.outputs.map((p) => p.producer),
    );
  }
  // The UNION port count per frame BEFORE routing — every seeded slot is a dataflow some
  // iteration realizes. After routing, any seeded slot NOT used by a drawn segment in the
  // current projection is a DORMANT stub (the shape-with-voids). Recorded now so a crossing
  // that appends a slot later isn't mistaken for a union port.
  const seededEntrance = new Map<number, number>([...entrancePorts].map(([f, a]) => [f, a.length]));
  const seededExit = new Map<number, number>([...exitPorts].map(([f, a]) => [f, a.length]));
  const usedPort = new Set<string>(); // `${frame}|${side}|${slot}` touched by a drawn segment
  const slotOf = (reg: Map<number, string[]>, frame: number, entity: string): number => {
    let arr = reg.get(frame);
    if (!arr) reg.set(frame, (arr = []));
    let i = arr.indexOf(entity);
    if (i === -1) {
      i = arr.length;
      arr.push(entity);
    }
    return i;
  };
  const endKey = (w: WireEnd): string => (w.kind === "card" ? `c${w.id}` : `p${w.frame}${w.side}${w.slot}`);
  const segments: WireSegment[] = [];
  const seenSeg = new Map<string, WireSegment>();
  const pushSeg = (from: WireEnd, to: WireEnd, entity: number, ghost = false, goto?: [number, number][]): boolean => {
    const k = `${endKey(from)}>${endKey(to)}`;
    const existing = seenSeg.get(k);
    if (existing) {
      // A realized edge SOLIDIFIES a hop a ghost drew first (edges route in original order —
      // tab-stable slot allocation — so either may come first). Claiming = drew or solidified.
      if (!ghost && existing.ghost) {
        existing.ghost = false;
        existing.goto = undefined;
        return true;
      }
      return false;
    }
    const seg: WireSegment = { from, to, entity, folds: 0, ghost, goto: ghost ? goto : undefined };
    seenSeg.set(k, seg);
    segments.push(seg);
    return true;
  };
  /** A wholly-duplicate route (a per-pass/per-element fold) bumps its TERMINAL segment's
   *  fold count — the view badges that hop `×(1+folds)`, so the wire says how many flows
   *  it represents instead of silently standing in for all of them. */
  const bumpFold = (from: WireEnd, to: WireEnd): void => {
    const seg = seenSeg.get(`${endKey(from)}>${endKey(to)}`);
    if (seg) seg.folds++;
  };

  // WIRE CONSERVATION — every edge is CLASSIFIED, never silently filtered. The non-`wire`
  // fates each have a defined rendering elsewhere (see `WireAudit`); `unaccounted` is a bug.
  const wireAudit: WireAudit = {
    wire: 0,
    folded: 0,
    loopback: 0,
    ghost: 0,
    containment: 0,
    unaccounted: 0,
  };
  // CROSS-ITERATION edges (a loop-carried back-edge across passes of the same fanout) ride the
  // TCO loop-back line, not an in-pass data wire (see `crossIteration`). Remember their producers'
  // STRUCTURAL scopes: a seeded port slot whose producer's flow rides the recursion line is
  // RECURSION-SERVED, not dormant — it must not stub.
  const recursionServed = new Set<string>();
  const dataEdges = graph.edges.filter((e) => {
    if (!crossIteration(e.from, e.to)) return true;
    wireAudit.loopback++;
    const r = byId.get(e.from);
    if (r?.kind === "leaf") recursionServed.add(r.scope);
    return false;
  });

  // ELK ORDERING via REAL PORTS. The drawn `way` already routes a value card→port→…→card
  // through the boundary ports of every container it crosses. We hand ELK that SAME path
  // as a chain of edges that dock at the actual port slots (a `port` end → that frame's
  // `elk.port` id; a `card` end → the node id). Each hop's two endpoints share one
  // container (their LCA), so under `SEPARATE_CHILDREN` the edge lives inside ONE
  // sub-layout — and because it docks at a FIXED_ORDER port, ELK's crossing-min now SEES
  // which slot a card feeds and orders the cards to match (this is what lets it move
  // `decide.prompt` below `analyze.prompt` so the two wires stop crossing). Resolved after
  // routing, once each frame's slot table is final. */
  const elkEnd = (w: WireEnd): { node: number; portId?: string } =>
    w.kind === "card" ? { node: w.id } : { node: w.frame, portId: `p${w.frame}:${w.side}:${w.slot}` };
  const deferred: [{ node: number; portId?: string }, { node: number; portId?: string }][] = [];

  // An edge endpoint may name an invocation that FOLDED onto another scope-instance — a
  // `map`'s per-iteration digest folds onto the representative digest, so an edge into
  // iteration-1's digest names an id that is NOT itself in `visible` (only its rep is). A raw
  // `liftToVisible` on such an id climbs PAST the folded node to the enclosing container, and
  // the edge then reads as a containment pair (line below) and is silently dropped — the wire
  // from an off-representative iteration's producer to the folded consumer vanishing. Map each
  // endpoint to its representative first (the rep is what's laid out + visible); identity for a
  // node already its own representative.
  const reprId = (id: number): number => {
    const r = byId.get(id);
    return r ? reprOf(r).id : id;
  };

  // ORIGINAL edge order — slot allocation must be tab-independent (flipping a Z-tab may not
  // reshuffle port slots). Ghost/solid interleaving is handled by pushSeg's solidify upgrade.
  for (const e of dataEdges) {
    const ghost = !realizedNow(e.from, e.to);
    const goto = ghost ? gotoOf(e.from, e.to) : undefined;
    const fromId = reprId(e.from);
    const toId = reprId(e.to);
    const vFrom = liftToVisible(fromId);
    const vTo = liftToVisible(toId);
    if (vFrom === null || vTo === null) {
      // An endpoint with NO visible ancestor — nothing represents this flow. A silent drop:
      // the audit test keeps this at 0; if a projection ever produces one, it must grow its
      // own materialization kind, not vanish.
      wireAudit.unaccounted++;
      continue;
    }
    if (vFrom === vTo || isVisAncestor(vFrom, vTo) || isVisAncestor(vTo, vFrom)) {
      // Both endpoints resolve into ONE visible node (folded onto the same card, or a pure
      // containment pair) — the flow is interior; the node itself renders it.
      wireAudit.containment++;
      continue;
    }

    // DRAWN WIRE: route the visible endpoints through the boundary ports of every
    // container that lies strictly between them.
    {
      const ca = chainToRoot(vFrom); // [vFrom, …visible ancestors…]
      const cb = chainToRoot(vTo);
      const idxB = new Map(cb.map((id, k) => [id, k]));
      // Lowest common visible ancestor; ca.length / cb.length when the LCA is the
      // synthetic ELK root (the chains share no region).
      let i = ca.length;
      let j = cb.length;
      for (let k = 0; k < ca.length; k++) {
        const m = idxB.get(ca[k]!);
        if (m !== undefined) {
          i = k;
          j = m;
          break;
        }
      }
      const entity = e.from; // concrete producer id — tags the route for tracing/colour
      const dataflow = scopeOf(e.from); // structural key — collapses iterations to one slot
      const way: WireEnd[] = [];
      // Producer side: the card (if visible) then a right-edge exit port for each
      // container it leaves, innermost→outermost. A hidden producer (`vFrom` is a
      // frame) contributes no card — its value emerges from that frame's exit port.
      //
      // PER-REGION OUTPUT + THE RETURN LINE (V, two rounds): a flow that EXITS a fan-out
      // is the fan-out's output — an ARRAY — so the CROSS-BOUNDARY wire is region-sourced
      // (boundary knob → consumer), never end-to-end item provenance. But the knob itself
      // must say WHICH section the body returns: the interior card→knob hop IS that
      // return line, drawn for a non-loop fan-out (map/filter — the fan-out that
      // RETURNS). A TCO loop is the exception ("not tco"): its return rides the
      // loop-back contour, so a route whose innermost crossed fan-out is a LOOP keeps
      // its card dropped — the hop survives only as an ELK ordering edge.
      const fromLeaf = isLeafId(vFrom);
      const innermostFanout = ca
        .slice(fromLeaf ? 1 : 0, i)
        .map((id) => byId.get(id))
        .find((r) => r?.kind === "fanout");
      const exitsLoop = innermostFanout?.kind === "fanout" && innermostFanout.loop === true;
      if (fromLeaf && !exitsLoop)
        way.push({ kind: "card", id: vFrom, field: vFrom === fromId ? e.fromField : undefined });
      if (fromLeaf && exitsLoop && i > 1) {
        const slot = slotOf(exitPorts, ca[1]!, dataflow);
        deferred.push([
          elkEnd({ kind: "card", id: vFrom }),
          elkEnd({ kind: "port", frame: ca[1]!, side: "out", slot }),
        ]);
      }
      for (let k = fromLeaf ? 1 : 0; k < i; k++) {
        const slot = slotOf(exitPorts, ca[k]!, dataflow);
        if (!ghost) usedPort.add(`${ca[k]}|out|${slot}`);
        way.push({ kind: "port", frame: ca[k]!, side: "out", slot });
      }
      // Consumer side: a left-edge entrance port for each container it enters,
      // outermost→innermost, then the card (if visible). A hidden consumer stops at
      // the outer frame's entrance port.
      const toLeaf = isLeafId(vTo);
      for (let k = j - 1; k >= (toLeaf ? 1 : 0); k--) {
        const slot = slotOf(entrancePorts, cb[k]!, dataflow);
        if (!ghost) usedPort.add(`${cb[k]}|in|${slot}`);
        way.push({ kind: "port", frame: cb[k]!, side: "in", slot });
      }
      if (toLeaf) way.push({ kind: "card", id: vTo, field: vTo === toId ? e.field : undefined });
      let claimed = false; // drew a new hop, or solidified a ghost one
      for (let k = 0; k + 1 < way.length; k++) {
        if (pushSeg(way[k]!, way[k + 1]!, entity, ghost, goto)) claimed = true;
        // Ghost hops DO steer ELK's ordering. The scope-fold makes routes rep-keyed, so the
        // UNION of realized+ghost routes is IDENTICAL on every tab — feeding ELK the union
        // keeps node order tab-STABLE, and a consumer stays causally right of its producer
        // even when the selected pass ghosts the concrete route (a TCO loop's OUTPUT is fed
        // only by the LAST pass: on any earlier tab that route is a ghost, and excluding it
        // left the output edge-less → ELK layer 0 → top-left, drawn backwards). Only the
        // drawn-wire bookkeeping (usedPort, fold badges) stays realized-only.
        deferred.push([elkEnd(way[k]!), elkEnd(way[k + 1]!)]);
      }
      // A route whose every hop was already claimed is a DUPLICATE of an existing wire (the
      // fold collapses N iterations' edges onto one route) — represented by it, and COUNTED
      // on its terminal hop so the badge says how many REALIZED flows the wire carries. An
      // UNREALIZED edge never counts as wire/folded-with-badge: fully-shared route →
      // represented by the wire (`folded`, unbadged); any hop of its own → GHOST spaghetti.
      if (ghost) {
        wireAudit[claimed ? "ghost" : "folded"]++;
      } else if (claimed) wireAudit.wire++;
      else {
        wireAudit.folded++;
        if (way.length >= 2) bumpFold(way[way.length - 2]!, way[way.length - 1]!);
      }
    }
  }

  // Attach the FIXED_ORDER ports ELK orders against. Slot 0 sits at the TOP of each side;
  // ELK reads port order clockwise from top-left, so an EAST (exit) slot maps to its index
  // directly, and a WEST (entrance) slot is reversed. Only ELK's NODE ordering uses these —
  // the drawn port y is recomputed from card centroids in `resolvePortPts`, so the port's
  // ELK position is discarded; these are pure ordering hints. Every visible fanout frame
  // (expanded or collapsed) carries its seeded+routed slots.
  const framesWithPorts = new Set<number>([...entrancePorts.keys(), ...exitPorts.keys()]);
  for (const frameId of framesWithPorts) {
    const node = elkById.get(frameId);
    if (!node) continue; // hidden behind a Z-tab — not laid out this projection
    const ins = entrancePorts.get(frameId) ?? [];
    const outs = exitPorts.get(frameId) ?? [];
    if (ins.length === 0 && outs.length === 0) continue;
    node.ports = [
      ...ins.map((_, slot) => ({
        id: `p${frameId}:in:${slot}`,
        layoutOptions: { "elk.port.side": "WEST", "elk.port.index": String(ins.length - 1 - slot) },
      })),
      ...outs.map((_, slot) => ({
        id: `p${frameId}:out:${slot}`,
        layoutOptions: { "elk.port.side": "EAST", "elk.port.index": String(slot) },
      })),
    ];
    node.layoutOptions = { ...(node.layoutOptions ?? {}), "elk.portConstraints": "FIXED_ORDER" };
  }

  // Resolve each routed hop to an ELK edge docked at its endpoints, hung on the container
  // that is the lowest common visible ancestor of both endpoints (a card→own-frame-port hop
  // lives inside that frame; a sibling exit→entrance hop lives in their shared parent).
  const ancestorsOf = (id: number): number[] => {
    const s: number[] = [];
    for (let c: number | null = id; c !== null; c = visParent(c)) s.push(c);
    return s;
  };
  const lcaOf = (a: number, b: number): number | null => {
    if (a === b) return a;
    const as = new Set(ancestorsOf(a));
    for (const x of ancestorsOf(b)) if (as.has(x)) return x;
    return null;
  };
  const seenElk = new Set<string>();
  for (const [a, b] of deferred) {
    const src = a.portId ?? String(a.node);
    const tgt = b.portId ?? String(b.node);
    const key = `${src}>${tgt}`;
    if (seenElk.has(key)) continue;
    seenElk.add(key);
    edgesFor(lcaOf(a.node, b.node)).push({ id: key, sources: [src], targets: [tgt] });
  }

  // PARALLEL TRACKS STACK VERTICALLY. ELK lays nodes into left→right layers FROM edges; a
  // node with no incoming edge sits in layer 0. Independent steps — each reads a shared
  // input and writes its own output, with no step→step dataflow (a `map` of independent
  // triages; a persona pipeline's extract-identity/hypothesis/impersonate all fanning off
  // ONE record) — have no edge between them, so ELK stacks them VERTICALLY in their causal
  // layer. That is CORRECT and load-bearing: the horizontal axis encodes DATAFLOW causality
  // ONLY (a producer sits left of its consumer); temporal/execution order is NOT a reason to
  // spread independent siblings left→right. So we deliberately do NOT synthesize emit-order
  // edges — independent work reads as parallel vertical tracks, never a false temporal chain.
  // (This file previously injected `seq:` fallback edges that forced exactly that
  // horizontal-temporal ordering; removed — parallel is vertical.)

  const elk = engine ?? (await getElk());
  const laidOut = await elk.layout({
    id: "root",
    layoutOptions: {
      ...LAYERED_ROOT_OPTIONS,
      ...READABILITY_OPTIONS,
      // Region isolation: each frame's contents lay out in their own sub-graph
      // (edges are resolved to sibling level and hung on their LCA frame, so
      // nothing needs the global cross-hierarchy solve `INCLUDE_CHILDREN` does —
      // that global solve is what made a deep trace stall).
      "elk.hierarchyHandling": "SEPARATE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "34",
    },
    children: roots,
    edges: rootEdges,
  });

  // Flatten ELK's nested result to a parent-relative list (parents first, so the
  // renderer can fold parent offsets into absolute coords in one pass).
  const nodes: PositionedRegion[] = [];
  const walk = (elkNode: ElkNode, parentId: number | null): void => {
    const region = byId.get(Number(elkNode.id));
    if (region) {
      nodes.push({
        region,
        x: elkNode.x ?? 0,
        y: elkNode.y ?? 0,
        width: elkNode.width ?? DEFAULT_CARD_W,
        height: elkNode.height ?? DEFAULT_CARD_H,
        isLeaf: region.kind === "leaf" || region.kind === "output",
        parentId,
        instances: instancesById.get(Number(elkNode.id)),
      });
    }
    for (const child of elkNode.children ?? []) walk(child, Number(elkNode.id));
  };
  for (const root of laidOut.children ?? []) walk(root, null);

  // DORMANT STUBS — seeded union ports the current projection didn't realize. Only for
  // VISIBLE frames (a hidden frame draws nothing); each is the shape-with-voids slot the
  // view stubs at the boundary, so the joint set is stable as tabs flip. A RECURSION-SERVED
  // slot (its producer's only flow is a loop-carried edge, drawn as the TCO loop-back) is not
  // dormant — the wire exists, it just rides the contour — so it never stubs.
  const stubs: { frame: number; side: "in" | "out"; slot: number; producer: string }[] = [];
  const addStubs = (seeded: Map<number, number>, ports: Map<number, string[]>, side: "in" | "out"): void => {
    for (const [frame, count] of seeded) {
      if (!visible.has(frame)) continue;
      const arr = ports.get(frame) ?? [];
      for (let slot = 0; slot < count; slot++) {
        if (usedPort.has(`${frame}|${side}|${slot}`)) continue;
        if (recursionServed.has(arr[slot] ?? "")) continue; // rides the TCO loop-back, not a void
        stubs.push({ frame, side, slot, producer: arr[slot] ?? "" });
      }
    }
  };
  addStubs(seededEntrance, entrancePorts, "in");
  addStubs(seededExit, exitPorts, "out");

  return { nodes, segments, stubs, wireAudit };
}
