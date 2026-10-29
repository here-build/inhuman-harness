import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { IconChevronRight, IconTool } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";

import { causalGraph, hasTools } from "./causal.js";
import type { CellSource } from "./cell.js";
import { fanoutOrder, mergedFanout, recurrenceSource } from "./iteration-flow.js";
import { LeafCard, MeasureCtx, OutputCard } from "./leaf-card.js";
import { type RegionLayout, regionElkLayout, type WireEnd } from "./region-elk-layout.js";
import {
  cardPoint,
  collectLeafIds,
  endPoint,
  FRAME_R,
  type LeafAnchors,
  loopFieldRecursionPath,
  loopIdentityPath,
  loopRecursionPath,
  type PlacedRegion,
  placeRegions,
  PORT_STEP,
  PORT_TOP,
  type Pt,
  resolvePortPts,
  roundedPolyline,
  sameAnchors,
  singleOutField,
  wirePath,
  zBox,
  zCard,
  zWire,
} from "./region-geometry.js";
import type { Leaf } from "./region-nesting.js";
import { Button } from "../components/ui/button.js";
import { glyph } from "../components/ui/glyph.js";
import type { AgentState } from "../shell/tape-read.js";

type Fanout = Extract<Region, { kind: "fanout" }>;

/** Past this a strip of tabs becomes a stepper: a deep loop's depth is its iteration count. */
const TAB_CAP = 16;
/** A merged frame's head is as wide as its one card; the strip has to fit there. */
const MERGED_TAB_CAP = 6;
/** The head band above a frame's top border, inside the room the layout reserves. */
const HEAD_H = 22;

const geometry = (p: PlacedRegion, top = 0, height = p.height) => ({
  left: p.ax,
  top: p.ay + top,
  width: p.width,
  height,
});

/* Chrome: frames. Greyscale all of it; only a tab's dot wears a state. */

const URGENCY: readonly AgentState[] = ["asking", "failed", "live"];

/** The state in an iteration that needs the eye: asking over failed over live; settled passes say nothing. */
function iterState(body: readonly Region[], cells: CellSource | undefined): AgentState | undefined {
  let worst = URGENCY.length;
  const walk = (regions: readonly Region[]): void => {
    for (const r of regions) {
      if (r.kind === "fanout") for (const pass of r.iterations) walk(pass);
      else if (r.kind === "leaf") {
        const state =
          cells?.get(r.id)?.state ?? (r.state === "running" ? "live" : r.state === "rejected" ? "failed" : "ok");
        const rank = URGENCY.indexOf(state);
        if (rank !== -1) worst = Math.min(worst, rank);
      }
    }
  };
  walk(body);
  return URGENCY[worst];
}

const FrameBox = observer(function FrameView({
  placed,
  depth,
  sel,
  collapsed,
  cells,
  onSelect,
  onToggle,
}: {
  readonly placed: PlacedRegion;
  readonly depth: number;
  readonly sel: number;
  readonly collapsed: boolean;
  readonly cells: CellSource | undefined;
  readonly onSelect: (id: number, i: number) => void;
  readonly onToggle: (id: number) => void;
}) {
  const region = placed.region as Fanout;
  const n = region.iterations.length;
  const merged = mergedFanout(region);
  const pick = (i: number) => onSelect(region.id, Math.min(n - 1, Math.max(0, i)));
  return (
    <>
      {/* A merged frame is its one card: the head is a hat on it, with no box around. */}
      {merged ? null : (
        <div
          className="wf-frame"
          style={{ zIndex: zBox(depth), ...geometry(placed, HEAD_H, placed.height - HEAD_H) }}
        />
      )}
      <div className="wf-frame-head" style={{ zIndex: zCard(depth), ...geometry(placed, 0, HEAD_H) }}>
        <button
          type="button"
          className="wf-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand" : "Collapse"}
          onClick={() => onToggle(region.id)}
        >
          <IconChevronRight {...glyph} aria-hidden className="wf-chevron" />
        </button>
        <span className="label wf-crumb">{fanoutOrder(region)}</span>
        {region.incoming > n ? (
          <span className="mono wf-count">
            {n} of {region.incoming}
          </span>
        ) : collapsed && n > 1 ? (
          <span className="mono wf-count">×{n}</span>
        ) : null}
        {collapsed || n < 2 ? null : n <= (merged ? MERGED_TAB_CAP : TAB_CAP) ? (
          <div role="tablist" aria-label="Iterations" className="wf-tabs">
            {region.iterations.map((body, i) => (
              <Tab
                key={i}
                label={`#${i + 1}`}
                selected={i === sel}
                mark={iterState(body, cells)}
                onClick={() => pick(i)}
              />
            ))}
          </div>
        ) : (
          <div role="group" aria-label="Iterations" className="wf-tabs">
            <button
              type="button"
              className="wf-tab mono"
              disabled={sel <= 0}
              aria-label="Previous"
              onClick={() => pick(sel - 1)}
            >
              ‹
            </button>
            <Tab label={`#${sel + 1}/${n}`} selected mark={iterState(region.iterations[sel] ?? [], cells)} />
            <button
              type="button"
              className="wf-tab mono"
              disabled={sel >= n - 1}
              aria-label="Next"
              onClick={() => pick(sel + 1)}
            >
              ›
            </button>
          </div>
        )}
      </div>
    </>
  );
});

function Tab({
  label,
  selected,
  mark,
  onClick,
}: {
  label: string;
  selected: boolean;
  mark: AgentState | undefined;
  onClick?: () => void;
}) {
  return (
    <button type="button" role="tab" className="wf-tab mono" aria-selected={selected} onClick={onClick}>
      {label}
      {mark === undefined ? null : (
        <span className="wf-dot" data-state={mark} role="img" aria-label={mark === "live" ? "running" : mark} />
      )}
    </button>
  );
}

/* Wires. Pure geometry from the layout and the measured anchors, banded by nesting depth. */

function drawWires(o: {
  readonly layout: RegionLayout;
  readonly placed: PlacedRegion[];
  readonly byId: Map<number, PlacedRegion>;
  readonly depthOf: Map<number, number>;
  readonly graph: RegionGraph;
  readonly selTabs: Map<number, number>;
  readonly anchors: Map<number, LeafAnchors>;
  readonly onSelect: (id: number, i: number) => void;
}): [number, ReactNode[]][] {
  const { layout, placed, byId, depthOf, graph, selTabs, anchors, onSelect } = o;
  // The layout folds a loop's passes onto the first pass's ids; the recurrence reads runtime ids.
  const reprMap = new Map<number, number>();
  for (const p of placed) for (const instance of p.instances ?? [p.region]) reprMap.set(instance.id, p.region.id);
  const reprOf = (id: number): number => reprMap.get(id) ?? id;
  const bands = new Map<number, ReactNode[]>();
  const push = (d: number, node: ReactNode): void => {
    const band = bands.get(d);
    if (band) band.push(node);
    else bands.set(d, [node]);
  };
  const depthOfEnd = (w: WireEnd): number => depthOf.get(w.kind === "card" ? w.id : w.frame) ?? 0;
  // No `field` means the value is consumed where the card starts reading: its message, or a tool's first argument.
  const segments = layout.segments.map((seg) =>
    seg.to.kind === "card" && seg.to.field === undefined ? { ...seg, to: { ...seg.to, field: "" } } : seg,
  );
  const portPts = resolvePortPts(segments, byId, anchors);
  // A merged frame is its one card: its crossings dock on the card's own edge, not a rail beside it.
  const onCard = new Set<number>();
  for (const p of placed) {
    if (p.region.kind !== "fanout" || !mergedFanout(p.region)) continue;
    const kids = placed.filter((q) => q.parentId === p.region.id);
    const only = kids.length === 1 ? kids.at(0) : undefined;
    if (only?.region.kind !== "leaf") continue;
    onCard.add(p.region.id);
    const card = { kind: "card", id: only.region.id, field: "" } as const;
    for (const [side, role] of [
      ["out", "from"],
      ["in", "to"],
    ] as const) {
      const dock = cardPoint(card, role, byId, anchors);
      if (dock) for (const k of portPts.keys()) if (k.startsWith(`${p.region.id}${side}`)) portPts.set(k, dock);
    }
  }
  const selOf = (f: Fanout): number => Math.min(selTabs.get(f.id) ?? 0, Math.max(0, f.iterations.length - 1));

  // TCO recursion: the pass's value leaves its producer, wraps the frame's contour, and lands in the slot it feeds next.
  const loops: { id: number; out?: string; in?: string; joint: Pt }[] = [];
  for (const p of placed) {
    const fr = p.region;
    if (fr.kind !== "fanout" || !fr.loop || fr.iterations.length < 2) continue;
    const sel = selOf(fr);
    let lowestIn = -Infinity;
    for (const [key, pt] of portPts) if (key.startsWith(`${fr.id}in`)) lowestIn = Math.max(lowestIn, pt.y);
    let joint: Pt = { x: p.ax, y: lowestIn > -Infinity ? lowestIn + PORT_STEP : p.ay + PORT_TOP };
    const members = collectLeafIds(fr.iterations.flat());
    const visible = collectLeafIds(fr.iterations[sel] ?? []);
    const carried = graph.edges.find((e) => visible.has(e.from) && members.has(e.to) && !visible.has(e.to));
    const sinkId = carried === undefined ? undefined : reprOf(carried.to);
    const sink =
      sinkId === undefined
        ? null
        : cardPoint({ kind: "card", id: sinkId, field: carried?.field ?? "" }, "to", byId, anchors);
    if (sink) joint = { x: p.ax, y: sink.y };
    let outPath: string | undefined;
    let inPath: string | undefined;
    if (sel < fr.iterations.length - 1) {
      const source = recurrenceSource(fr.iterations[sel] ?? [], graph.edges);
      const node = source.kind === "producer" ? byId.get(reprOf(source.id)) : undefined;
      if (node) {
        // A fanout source leaves by its exit knob; a card by the one row that recurs.
        const field =
          node.region.kind === "leaf" ? (carried?.fromField ?? singleOutField(node.region.value)) : undefined;
        const src =
          node.region.kind === "fanout"
            ? (portPts.get(`${node.region.id}out0`) ?? { x: node.ax + node.width, y: node.ay + node.height / 2 })
            : (cardPoint({ kind: "card", id: node.region.id, field }, "from", byId, anchors) ?? {
                x: node.ax + node.width,
                y: node.ay + node.height / 2,
              });
        outPath = sink ? loopFieldRecursionPath(p, src, sink) : loopRecursionPath(p, src, joint);
      } else if (source.kind === "passthrough") outPath = loopIdentityPath(p, joint);
    }
    // The last pass has no wrap out; a short rise says the previous round seeded it.
    if (sel >= 1 && !outPath) {
      const edge = sink ? undefined : graph.edges.find((e) => visible.has(e.to) && members.has(e.from));
      const arrival =
        sink ??
        (edge ? cardPoint({ kind: "card", id: reprOf(edge.to), field: edge.field ?? "" }, "to", byId, anchors) : null);
      if (arrival) {
        const rise = [
          { x: p.ax, y: p.ay + p.height },
          { x: p.ax, y: arrival.y },
        ];
        if (arrival.x - p.ax > 1) rise.push({ x: arrival.x, y: arrival.y });
        inPath = roundedPolyline(rise, FRAME_R);
      }
    }
    if (outPath || inPath) loops.push({ id: fr.id, out: outPath, in: inPath, joint });
  }
  // On a recursing pass the value wraps back instead of leaving, so the internal hops to and from the ports go.
  const recursing = new Set(loops.filter((l) => l.out).map((l) => l.id));
  const recursed = new Set(loops.filter((l) => l.in).map((l) => l.id));

  for (const [i, seg] of segments.entries()) {
    if (seg.to.kind === "port" && seg.to.side === "out" && recursing.has(seg.to.frame) && seg.from.kind === "card")
      continue;
    if (seg.from.kind === "port" && seg.from.side === "in" && recursed.has(seg.from.frame) && seg.to.kind === "card")
      continue;
    const a = endPoint(seg.from, "from", byId, anchors, portPts);
    const b = endPoint(seg.to, "to", byId, anchors, portPts);
    if (!a || !b) continue;
    const d = Math.max(depthOfEnd(seg.from), depthOfEnd(seg.to));
    // Over a short hop the stock S-curve overshoots into a squiggle; centre the handles instead.
    const mid = (a.x + b.x) / 2;
    const path =
      Math.abs(b.x - a.x) < 48 ? `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}` : wirePath(a, b);
    // A ghost route exists only in other iterations; clicking it is the way there.
    if (seg.ghost) {
      const goto = seg.goto ?? [];
      push(
        d,
        <g key={`seg${i}`}>
          <path d={path} className="wf-wire" data-ghost="" />
          {goto.length === 0 ? null : (
            <path
              d={path}
              className="wf-hit"
              onClick={() => {
                for (const [fanout, k] of goto) onSelect(fanout, k);
              }}
            >
              <title>{`In another pass: switch to ${goto.map(([, k]) => `#${k + 1}`).join(" ")}`}</title>
            </path>
          )}
        </g>,
      );
      continue;
    }
    push(d, <path key={`seg${i}`} d={path} className="wf-wire" />);
    // One drawn route standing for several per-pass flows says how many, on a pill at its middle.
    if (seg.folds > 0) {
      const label = `×${1 + seg.folds}`;
      const [x, y, w] = [(a.x + b.x) / 2, (a.y + b.y) / 2, label.length * 7 + 10];
      push(
        d,
        <g key={`fold${i}`}>
          <rect x={x - w / 2} y={y - 8} width={w} height={16} rx={8} className="wf-fold-pill" />
          <text x={x} y={y} dy="0.35em" textAnchor="middle" className="wf-fold">
            {label}
          </text>
        </g>,
      );
    }
  }
  // Ports are frame semantics: a nub per place on a frame's edge, none where the frame is just its card.
  const nubs = new Set<string>();
  for (const [key, pt] of portPts) {
    const frame = Number(/^(\d+)/.exec(key)?.[1]);
    const at = `${frame}:${Math.round(pt.x)}:${Math.round(pt.y)}`;
    if (onCard.has(frame) || nubs.has(at)) continue;
    nubs.add(at);
    push(depthOf.get(frame) ?? 0, <circle key={`port${key}`} cx={pt.x} cy={pt.y} r={2.5} className="wf-port" />);
  }
  for (const l of loops)
    push(
      depthOf.get(l.id) ?? 0,
      <g key={`loop${l.id}`}>
        {l.out ? <path d={l.out} className="wf-loop" markerEnd="url(#wf-arrow)" /> : null}
        {l.in ? <path d={l.in} className="wf-loop" markerEnd="url(#wf-arrow)" /> : null}
        <circle cx={l.joint.x} cy={l.joint.y} r={2.5} className="wf-port" />
      </g>,
    );
  return [...bands].sort(([a], [b]) => a - b);
}

/* The graph: measure the cards, lay them out, place them, draw the wires between. */

const NodeCard = observer(function NodeView({
  placed,
  show,
  cells,
  onPick,
}: {
  readonly placed: PlacedRegion;
  readonly show: Leaf;
  readonly cells: CellSource | undefined;
  readonly onPick: ((leaf: Leaf) => void) | undefined;
}) {
  return <LeafCard leaf={show} id={placed.region.id} cell={cells?.get(show.id)} onPick={onPick} />;
});

/** Before the first layout: the first pass's cards, so they exist, hidden, and can be measured. */
function unplaced(regions: readonly Region[]): PlacedRegion[] {
  return regions.flatMap((region): PlacedRegion[] => {
    if (region.kind === "fanout") return unplaced(region.iterations[0] ?? []);
    return [{ region, x: 0, y: 0, width: 0, height: 0, isLeaf: true, parentId: null, ax: 0, ay: 0 }];
  });
}

export function WorkflowGraph({
  graph: run,
  cells,
  onPick,
}: {
  readonly graph: RegionGraph;
  /** invocation id → live face of the call. Absent for a settled trace. */
  readonly cells?: CellSource;
  readonly onPick?: (leaf: Leaf) => void;
}) {
  const [tools, setTools] = useState(true);
  const graph = useMemo(() => causalGraph(run, { tools }), [run, tools]);
  const toolsRan = useMemo(() => hasTools(run.roots), [run]);
  const [selTabs, setSelTabs] = useState(() => new Map<number, number>());
  const [collapsed, setCollapsed] = useState(() => new Set<number>());
  const [layout, setLayout] = useState<RegionLayout | null>(null);
  // Hidden until the layout has met the cards' real sizes once; after that tabs and streams re-lay in place.
  const [ready, setReady] = useState(false);
  const [, setAnchorTick] = useState(0);
  // Sizes drive ELK; anchors only re-route wires inside placed cards, so they cost a render, not a layout.
  const els = useRef(new Map<number, HTMLElement>());
  const sizes = useRef(new Map<number, { width: number; height: number }>());
  const anchors = useRef(new Map<number, LeafAnchors>());
  const raf = useRef(0);
  const seq = useRef(0);
  const landed = useRef(false);

  const onSelect = useCallback((id: number, i: number) => setSelTabs((m) => new Map(m).set(id, i)), []);
  const onToggle = useCallback(
    (id: number) =>
      setCollapsed((s) => {
        const next = new Set(s);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  // A seq guard keeps a slow layout from landing over a newer one.
  const relayout = useCallback(() => {
    const mine = ++seq.current;
    void (async () => {
      try {
        const next = await regionElkLayout(graph, selTabs, (id) => sizes.current.get(id), collapsed);
        if (mine !== seq.current) return;
        landed.current = true;
        setLayout(next);
      } catch (error) {
        // Thrown from the render, so the story gate and an error boundary see it.
        setLayout(() => {
          throw error;
        });
      }
    })();
  }, [graph, selTabs, collapsed]);

  const measure = useCallback(() => {
    let sizeChanged = false;
    let anchorChanged = false;
    for (const [id, el] of els.current) {
      const { offsetWidth: width, offsetHeight: height } = el;
      if (width === 0 || height === 0) continue; // not laid out: nothing to learn
      const prev = sizes.current.get(id);
      if (!prev || Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1) {
        sizes.current.set(id, { width, height });
        sizeChanged = true;
      }
      const top = el.getBoundingClientRect().top;
      const centre = (node: Element): number => {
        const r = node.getBoundingClientRect();
        return r.top - top + r.height / 2;
      };
      const next: LeafAnchors = { fields: new Map() };
      const result = el.querySelector('[data-anchor="result"]');
      if (result) next.result = centre(result);
      for (const row of el.querySelectorAll<HTMLElement>("[data-field]"))
        next.fields.set(`${row.dataset.role ?? "in"}:${row.dataset.field ?? ""}`, centre(row));
      // A wire with no named field docks at the first thing the card reads (its message, a tool's first argument).
      const first = el.querySelector('[data-role="in"]');
      if (first && !next.fields.has("in:")) next.fields.set("in:", centre(first));
      const prevAnchors = anchors.current.get(id);
      if (!prevAnchors || !sameAnchors(prevAnchors, next)) {
        anchors.current.set(id, next);
        anchorChanged = true;
      }
    }
    if (sizeChanged) relayout();
    else if (landed.current) {
      if (anchorChanged) setAnchorTick((n) => n + 1);
      setReady(true);
    }
  }, [relayout]);

  // Cards register for the life of their element, so the callbacks stay put while `measure` follows the latest graph.
  const latest = useRef(measure);
  latest.current = measure;
  const schedule = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => latest.current());
  }, []);
  const resizer = useRef<ResizeObserver | null>(null);
  const register = useCallback(
    (id: number, el: HTMLElement | null) => {
      resizer.current ??= typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
      if (el) {
        els.current.set(id, el);
        resizer.current?.observe(el);
      } else {
        const gone = els.current.get(id);
        if (gone) resizer.current?.unobserve(gone);
        els.current.delete(id);
        anchors.current.delete(id);
        sizes.current.delete(id);
      }
      schedule();
    },
    [schedule],
  );

  useEffect(relayout, [relayout]);
  useEffect(schedule, [layout, schedule]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      resizer.current?.disconnect();
    },
    [],
  );

  if (graph.roots.length === 0) return <p className="wf-empty">Nothing has run yet.</p>;

  const { placed, width, height, depthOf } = layout
    ? placeRegions(layout)
    : { placed: unplaced(graph.roots), width: 0, height: 0, depthOf: new Map<number, number>() };
  const byId = new Map(placed.map((p) => [p.region.id, p]));
  const selOf = (id: number, n: number): number => Math.min(selTabs.get(id) ?? 0, Math.max(0, n - 1));
  // The layout holds one card per call site; the tab says which pass's call it shows.
  const shown = (p: PlacedRegion): Leaf => {
    const instances = p.instances;
    if (!instances || instances.length < 2) return p.region as Leaf;
    for (let at = p.parentId; at != null; at = byId.get(at)?.parentId ?? null) {
      const frame = byId.get(at)?.region;
      if (frame?.kind === "fanout")
        return (instances[Math.min(selOf(at, frame.iterations.length), instances.length - 1)] ?? p.region) as Leaf;
    }
    return p.region as Leaf;
  };
  const wires = layout
    ? drawWires({ layout, placed, byId, depthOf, graph, selTabs, anchors: anchors.current, onSelect })
    : null;

  return (
    <div className="wf-canvas" data-ready={ready || undefined}>
      {toolsRan ? (
        <div className="wf-bar">
          <Button variant="ghost" className="wf-bar-toggle" aria-pressed={tools} onClick={() => setTools((on) => !on)}>
            <IconTool {...glyph} aria-hidden />
            Tools
          </Button>
        </div>
      ) : null}
      <MeasureCtx.Provider value={register}>
        <div className="wf-wrap" style={{ width, height }}>
          <svg className="wf-svg" width="0" height="0" aria-hidden="true">
            <defs>
              <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" className="wf-arrow" />
              </marker>
            </defs>
          </svg>
          {/* One layer per depth, between that depth's boxes and its cards: a deep wire crosses its ancestors' frames, not a card beside it. */}
          {wires?.map(([d, nodes]) => (
            <svg
              key={d}
              className="wf-svg"
              style={{ zIndex: zWire(d) }}
              width={width}
              height={height}
              aria-hidden="true"
            >
              {nodes}
            </svg>
          ))}
          {placed.map((p) => {
            const d = depthOf.get(p.region.id) ?? 0;
            const { region } = p;
            if (region.kind === "leaf" || region.kind === "output")
              return (
                <div key={region.id} className="wf-node" style={{ zIndex: zCard(d), left: p.ax, top: p.ay }}>
                  {region.kind === "leaf" ? (
                    <NodeCard placed={p} show={shown(p)} cells={cells} onPick={onPick} />
                  ) : (
                    <OutputCard region={region} />
                  )}
                </div>
              );
            // The causal graph has no decision regions, so what is left is a frame.
            return region.kind === "fanout" ? (
              <FrameBox
                key={region.id}
                placed={p}
                depth={d}
                sel={selOf(region.id, region.iterations.length)}
                collapsed={collapsed.has(region.id)}
                cells={cells}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ) : null;
          })}
        </div>
      </MeasureCtx.Provider>
    </div>
  );
}
