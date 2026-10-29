import { CallJob, SessionPlexus, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { onTestFinished } from "vitest";

import { KernelToolCatalog, type CatalogEntry } from "../../tool-catalog/index.js";
import type { AgentCallScope, AgentRuntimeHost, CallsCatalog } from "../types.js";

export function botCall(
  wireName: string,
  extra: {
    lifetime?: "turn" | "call";
    show?: "result" | "omit" | "turn";
    background?: boolean;
    pluginName?: string;
    target?: string;
  } = {},
): CatalogEntry {
  const pluginName = extra.pluginName ?? "pack";
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "effect",
    source: { kind: "pack", pluginName },
    packMeta: {
      kind: "bot-call",
      pluginName,
      target: extra.target ?? "worker",
      background: extra.background ?? true,
      lifetime: extra.lifetime ?? "call",
      show: extra.show ?? "result",
      supportsNotify: false,
    },
  };
}

export function callsCatalog(
  entries: CatalogEntry[] = [],
  opts?: {
    botRevisions?: ReadonlyMap<string, string>;
    plugins?: ReadonlyMap<string, { readonly definition: unknown }>;
  },
): CallsCatalog {
  const table = new KernelToolCatalog();
  if (entries.length > 0) table.replacePack(entries);
  if (opts?.botRevisions != null) table.botRevisions = opts.botRevisions;
  onTestFinished(() => table[Symbol.dispose]());
  return {
    catalogEntry: (name) => table.catalogEntry(name),
    botRevisions: table.botRevisions,
    pluginInstall: opts?.plugins == null ? undefined : { plugins: opts.plugins },
  };
}

export function sessionOf(id: string): SessionPlexus {
  const plexus = SessionPlexus.create(id, `/tmp/agent-calls/${id}`);
  onTestFinished(() => plexus.destroy());
  return plexus;
}

export function closedTurn(child: CallJob): SessionTurn {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    reducerExited: true,
  });
  turn.pushChild(child);
  return turn;
}

export function scopeOf(...plexuses: SessionPlexus[]): AgentCallScope {
  const map = new Map(plexuses.map((plexus) => [plexus.root.sessionId, plexus]));
  return {
    replica: (id) => map.get(id),
  };
}

export function hostOf(caller: SessionPlexus, catalog: CallsCatalog, extra: SessionPlexus[] = []): AgentRuntimeHost {
  return {
    caller: caller.root,
    catalog,
    scope: scopeOf(caller, ...extra),
  };
}
