import { jsonValueSchema } from "@inhuman.tools/harness-contract/schema";
import { Model, model, state } from "@inhuman.tools/model";
import { z } from "zod";

@model("harness:session:plugin-action")
export class PluginAction extends Model {
  @state accessor namespace = "";
  @state accessor actionJson: string | null = null;
  @state.ref accessor tail: PluginAction | null = null;
}

export function pluginLogRows(head: PluginAction): PluginAction[] {
  const rows: PluginAction[] = [];
  const seen = new Set<PluginAction>();
  let row: PluginAction | null = head;
  while (row !== null) {
    if (seen.has(row)) throw new TypeError("plugin log cycle");
    seen.add(row);
    if (row.actionJson !== null) rows.push(row);
    row = row.tail;
  }
  return rows.toReversed();
}

export function pluginLogs(heads: readonly PluginAction[]): Record<string, string> {
  return Object.fromEntries(
    heads.map((head) => [
      head.namespace,
      `[${pluginLogRows(head)
        .map((row) => row.actionJson)
        .join(",")}]`,
    ]),
  );
}

/** Reuse the common prefix on append, rollback, or branching after a rewind. */
export function pluginLogHeads(
  logs: Readonly<Record<string, string>>,
  previous: readonly PluginAction[],
): PluginAction[] {
  const heads = new Map(previous.map((head) => [head.namespace, head]));
  return Object.entries(logs).map(([namespace, json]) => {
    const actions = z
      .array(jsonValueSchema)
      .parse(JSON.parse(json))
      .map((action) => JSON.stringify(action));
    const old = heads.get(namespace);
    const rows = old === undefined ? [] : pluginLogRows(old);
    let common = 0;
    while (common < actions.length && common < rows.length && rows[common]?.actionJson === actions[common]) common++;
    let tail = common === 0 ? null : (rows[common - 1] ?? null);
    for (let index = common; index < actions.length; index++) {
      tail = new PluginAction({ namespace, actionJson: actions[index], tail });
    }
    return tail ?? (old?.actionJson === null ? old : new PluginAction({ namespace }));
  });
}
