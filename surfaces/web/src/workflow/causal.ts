import type { Region, RegionGraph } from "@here.build/arrival-provenance";
import { isWorkflowLeafMeta } from "@inhuman.tools/harness-model/session";

type Edge = RegionGraph["edges"][number];
type Fanout = Extract<Region, { kind: "fanout" }>;
type Port = Fanout["inputs"][number];

const isTool = (region: Region): boolean =>
  region.kind === "leaf" && isWorkflowLeafMeta(region.meta) && region.meta.kind === "tool";

/** Whether a run called any tool, so hiding them would change anything. */
export const hasTools = (regions: readonly Region[]): boolean =>
  regions.some((r) => (r.kind === "fanout" ? r.iterations.some(hasTools) : isTool(r)));

/**
 * The graph as what happened due to what: the crossings and the data between them. A decision
 * goes, wires and all; the work it gated stays, and that work's own inputs say why it ran. A
 * hidden tool is contracted: whatever fed it wires straight to whatever read its result.
 */
export function causalGraph(graph: RegionGraph, { tools }: { readonly tools: boolean }): RegionGraph {
  const decisions = new Set<number>();
  const hidden: number[] = [];
  const keep = (regions: readonly Region[]): Region[] =>
    regions.flatMap((region): Region[] => {
      if (region.kind === "decision") decisions.add(region.id);
      else if (!tools && isTool(region)) hidden.push(region.id);
      else if (region.kind !== "fanout") return [region];
      else {
        const iterations = region.iterations.map(keep).filter((body) => body.length > 0);
        return iterations.length === 0 ? [] : [{ ...region, iterations }];
      }
      return [];
    });
  const roots = keep(graph.roots);

  // Control edges only ever leave a decision; data into one fed nothing that ran.
  let edges = graph.edges.filter((e) => e.kind === "data" && !decisions.has(e.from) && !decisions.has(e.to));
  for (const id of hidden) {
    const ins = edges.filter((e) => e.to === id);
    const outs = edges.filter((e) => e.from === id);
    edges = edges.filter((e) => e.to !== id && e.from !== id);
    for (const i of ins)
      for (const o of outs)
        if (i.from !== o.to)
          edges.push({
            from: i.from,
            to: o.to,
            kind: "data",
            ...(i.fromField === undefined ? {} : { fromField: i.fromField }),
            ...(o.field === undefined ? {} : { field: o.field }),
          });
  }
  const seen = new Set<string>();
  edges = edges.filter((e) => {
    const key = `${e.from}>${e.to}:${e.fromField ?? ""}:${e.field ?? ""}`;
    return !seen.has(key) && seen.add(key);
  });

  derivePorts(roots, edges);
  return { ...graph, roots, edges };
}

/**
 * A frame's ports are the wires that cross its edge, one per producer and slot. The analysis
 * derives them over the full graph; contraction moves wires, so they are derived again here.
 * Writes into the fanouts `keep` just copied.
 */
function derivePorts(roots: readonly Region[], edges: readonly Edge[]): void {
  const frames = new Map<number, readonly number[]>();
  const scopes = new Map<number, string>();
  const fanouts: Fanout[] = [];
  const walk = (regions: readonly Region[], around: readonly number[]): void => {
    for (const region of regions) {
      frames.set(region.id, around);
      if (region.kind === "leaf") scopes.set(region.id, region.scope);
      if (region.kind === "fanout") {
        fanouts.push(region);
        for (const body of region.iterations) walk(body, [...around, region.id]);
      }
    }
  };
  walk(roots, []);

  const ports = new Map<string, Map<string, Port>>();
  const add = (side: "in" | "out", frame: number, producer: string, field: string | undefined): void => {
    const table = ports.get(`${side}${frame}`) ?? ports.set(`${side}${frame}`, new Map()).get(`${side}${frame}`)!;
    table.set(`${producer}|${field ?? ""}`, field === undefined ? { producer } : { producer, field });
  };
  for (const e of edges) {
    const producer = scopes.get(e.from);
    if (producer === undefined) continue;
    const from = new Set(frames.get(e.from));
    const to = new Set(frames.get(e.to));
    for (const frame of to) if (!from.has(frame)) add("in", frame, producer, e.field);
    for (const frame of from) if (!to.has(frame)) add("out", frame, producer, e.field);
  }
  const sorted = (table: Map<string, Port> | undefined): Port[] =>
    [...(table?.values() ?? [])].sort((a, b) =>
      a.producer === b.producer ? (a.field ?? "").localeCompare(b.field ?? "") : a.producer.localeCompare(b.producer),
    );
  for (const fanout of fanouts) {
    fanout.inputs = sorted(ports.get(`in${fanout.id}`));
    fanout.outputs = sorted(ports.get(`out${fanout.id}`));
  }
}
