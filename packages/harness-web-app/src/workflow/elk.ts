/**
 * elk — the lazy main-thread elkjs instance + the `layered` option block every graph
 * surface shares. One path for the app, Storybook and vitest: `elk.bundled.js` is
 * dynamically imported on first layout, so its ~1.4MB stays out of the main chunk
 * until a workflow graph is actually drawn.
 */
import type { ElkNode } from "elkjs/lib/elk-api.js";

export type ElkEngine = { layout(graph: ElkNode): Promise<ElkNode> };

// elkjs is CJS with an ESM-style .d.ts (`export default ElkConstructor`): under NodeNext the
// dynamic-import `default` types as the module namespace (no construct signature), while at
// runtime it IS the constructor. Cast to the ctor shape.
type ElkCtor = new () => ElkEngine;

let elk: Promise<ElkEngine> | null = null;

/** The shared engine, constructed once. Layout tests inject their own via the `engine?` parameter. */
export function getElk(): Promise<ElkEngine> {
  return (elk ??= import("elkjs/lib/elk.bundled.js").then((m) => new (m.default as unknown as ElkCtor)()));
}

/** The `layered` root options: left→right Lamport layers, nested frames laid out with
 *  their parents (`INCLUDE_CHILDREN`), model order respected so siblings keep authored
 *  order. Per-surface spacing rides on top via a spread. */
export const LAYERED_ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

export { type ElkNode } from "elkjs/lib/elk-api.js";
