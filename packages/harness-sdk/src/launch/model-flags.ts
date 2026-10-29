/**
 * `--connection` / `--model` resolve against live completion catalogs.
 * Session apply is the same kv/set `/model` writes. Unsupported verbs crash
 * before the daemon work they would otherwise start.
 */
import type { KernelRpc } from "../client.js";

/** Same ceiling as scheme_repl inventory enumerate — do not dump OpenRouter. */
const MODEL_LIST_MAX = 12;

export type CliAgentFlags = {
  readonly connection?: string;
  readonly model?: string;
};

export type ResolvedAgent = {
  readonly connection: string;
  readonly model?: string;
};

export type ConnectionRow = {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly abilityClaim: readonly string[];
  readonly enabled: boolean;
};

export type CompletionCatalogRow = {
  readonly id: string;
  readonly models: readonly string[];
  readonly error: string;
};

export type ResolveAgentInput = {
  readonly flags: CliAgentFlags;
  readonly connections: readonly ConnectionRow[];
  readonly catalogs?: readonly CompletionCatalogRow[];
};

export type ResolveAgentResult =
  { readonly ok: true; readonly agent: ResolvedAgent } | { readonly ok: false; readonly error: string };

export function hasCliAgentFlags(flags: CliAgentFlags): boolean {
  return nonempty(flags.connection) != null || nonempty(flags.model) != null;
}

export function unsupportedAgentFlagsError(surface: string): string {
  return [
    `--model and --connection are only valid for a session (TUI, --continue, eval, -p, or a .scm program).`,
    `\`${surface}\` does not select a model.`,
  ].join("\n");
}

export function resolveAgent(input: ResolveAgentInput): ResolveAgentResult {
  const wantedConnection = nonempty(input.flags.connection);
  const wantedModel = nonempty(input.flags.model);
  if (wantedConnection == null && wantedModel == null) {
    return { ok: true, agent: { connection: "" } };
  }

  const completion = input.connections.filter((row) => row.abilityClaim.includes("completion"));
  const enabledCompletion = completion.filter((row) => row.enabled);
  if (wantedConnection != null) {
    const row = input.connections.find((item) => item.id === wantedConnection);
    if (row == null) {
      return { ok: false, error: unknownConnectionError(wantedConnection, input.connections) };
    }
    if (!row.abilityClaim.includes("completion")) {
      return {
        ok: false,
        error: [
          `connection ${quote(wantedConnection)} is not a completion connection (${row.driver}).`,
          completionLine(enabledCompletion),
        ].join("\n"),
      };
    }
    if (!row.enabled) {
      return { ok: false, error: `connection ${quote(wantedConnection)} is disabled.` };
    }
  }

  if (wantedModel == null) {
    return { ok: true, agent: { connection: wantedConnection! } };
  }
  if (input.catalogs == null) {
    return {
      ok: true,
      agent:
        wantedConnection == null
          ? { connection: "", model: wantedModel }
          : { connection: wantedConnection, model: wantedModel },
    };
  }

  const catalogs = input.catalogs;
  if (wantedConnection != null) {
    const catalog = catalogs.find((row) => row.id === wantedConnection);
    if (catalog == null) {
      return {
        ok: false,
        error: `connection ${quote(wantedConnection)} did not return a model catalog.`,
      };
    }
    if (!catalog.models.includes(wantedModel)) {
      return { ok: false, error: missingOnConnectionError(wantedConnection, wantedModel, catalog) };
    }
    return { ok: true, agent: { connection: wantedConnection, model: wantedModel } };
  }

  const hits = catalogs.filter((row) => row.models.includes(wantedModel));
  if (hits.length === 1) {
    return { ok: true, agent: { connection: hits[0]!.id, model: wantedModel } };
  }
  if (hits.length > 1) {
    const names = hits.map((row) => row.id).sort();
    return {
      ok: false,
      error: [
        `model ${quote(wantedModel)} is available on multiple connections: ${names.join(", ")}.`,
        `Pass --connection to pick one.`,
      ].join("\n"),
    };
  }
  return { ok: false, error: missingAcrossError(wantedModel, catalogs, enabledCompletion) };
}

export async function resolveCliAgent(rpc: KernelRpc, flags: CliAgentFlags): Promise<ResolveAgentResult> {
  if (!hasCliAgentFlags(flags)) return { ok: true, agent: { connection: "" } };
  const listed = await rpc.request("connect/list", {});
  const connections = connectionRowsOf(listed);
  const preview = resolveAgent({ flags, connections });
  if (!preview.ok) return preview;
  if (nonempty(flags.model) == null) return preview;
  const wantedConnection = nonempty(flags.connection);
  const catalogs = catalogRowsOf(
    await rpc.request("connect/models", wantedConnection == null ? {} : { id: wantedConnection }),
  );
  return resolveAgent({ flags, connections, catalogs });
}

export async function applyResolvedAgent(
  request: (method: string, params: unknown) => Promise<unknown>,
  agent: ResolvedAgent,
): Promise<void> {
  const connection = nonempty(agent.connection);
  const model = nonempty(agent.model);
  if (connection == null && model == null) return;
  if (connection != null) {
    await request("kv/set", { key: "connection", value: connection });
  }
  if (model != null) {
    await request("kv/set", { key: "model", value: model });
  }
}

function connectionRowsOf(payload: unknown): ConnectionRow[] {
  if (payload == null || typeof payload !== "object" || !("connections" in payload)) return [];
  const raw = (payload as { connections: unknown }).connections;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (row == null || typeof row !== "object") return [];
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (id === "") return [];
    const can = Array.isArray(rec.abilityClaim) ? rec.abilityClaim.map(String) : [];
    return [
      {
        id,
        name: typeof rec.name === "string" ? rec.name : id,
        driver: typeof rec.driver === "string" ? rec.driver : "",
        abilityClaim: can,
        enabled: rec.enabled !== false,
      },
    ];
  });
}

function catalogRowsOf(payload: unknown): CompletionCatalogRow[] {
  if (payload == null || typeof payload !== "object" || !("connections" in payload)) return [];
  const raw = (payload as { connections: unknown }).connections;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (row == null || typeof row !== "object") return [];
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (id === "") return [];
    return [
      {
        id,
        models: Array.isArray(rec.models) ? rec.models.map(String) : [],
        error: typeof rec.error === "string" ? rec.error : "",
      },
    ];
  });
}

function unknownConnectionError(id: string, connections: readonly ConnectionRow[]): string {
  const completion = connections.filter((row) => row.abilityClaim.includes("completion") && row.enabled);
  const mcp = connections.filter(
    (row) => row.abilityClaim.includes("mcp") && !row.abilityClaim.includes("completion") && row.enabled,
  );
  const lines = [`unknown connection ${quote(id)}.`];
  if (connections.length === 0) {
    lines.push("No connections are configured.");
    return lines.join("\n");
  }
  lines.push(completionLine(completion));
  if (mcp.length > 0) {
    lines.push(`MCP connections: ${ids(mcp)}.`);
  }
  return lines.join("\n");
}

function missingOnConnectionError(connection: string, model: string, catalog: CompletionCatalogRow): string {
  const lines = [`model ${quote(model)} is not available on connection ${quote(connection)}.`];
  if (catalog.models.length === 0) {
    const status = catalog.error.trim() === "" ? "no models loaded" : catalog.error.trim();
    lines.push(`Connection ${quote(connection)} has no models (${status}).`);
    return lines.join("\n");
  }
  lines.push(`Models on ${connection}: ${formatModels(catalog.models)}.`);
  return lines.join("\n");
}

function missingAcrossError(
  model: string,
  catalogs: readonly CompletionCatalogRow[],
  completion: readonly ConnectionRow[],
): string {
  const lines = [`model ${quote(model)} was not found on any completion connection.`];
  if (catalogs.length === 0) {
    lines.push(completionLine(completion));
    return lines.join("\n");
  }
  const searched = catalogs.map((row) => {
    const models = row.models.length === 0 ? emptyCatalogNote(row) : formatModels(row.models);
    return `${row.id} (${models})`;
  });
  lines.push(`Searched: ${searched.join("; ")}.`);
  return lines.join("\n");
}

function emptyCatalogNote(row: CompletionCatalogRow): string {
  return row.error.trim() === "" ? "no models loaded" : row.error.trim();
}

function completionLine(rows: readonly ConnectionRow[]): string {
  if (rows.length === 0) return "No completion connections are configured.";
  return `Completion connections: ${ids(rows)}.`;
}

function formatModels(models: readonly string[]): string {
  if (models.length <= MODEL_LIST_MAX) return models.join(", ");
  const shown = models.slice(0, MODEL_LIST_MAX);
  return `${shown.join(", ")}, and ${models.length - shown.length} more`;
}

function ids(rows: readonly ConnectionRow[]): string {
  return [...rows]
    .map((row) => row.id)
    .sort()
    .join(", ");
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
