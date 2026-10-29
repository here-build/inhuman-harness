import { CompletionJob, SessionTurn } from "@inhuman.tools/harness-model";

import { wireAccount, type AccountSource, type WireAccount } from "./wire-account.js";

/** A completion wire and one live model id on it. */
export type ModelChoice = {
  readonly connection: string;
  readonly model: string;
};

/** Enough of a kernel connection to list completion models and paint its account. */
export type ModelCatalogSource = AccountSource & {
  readonly id: string;
  /** The connection's own display name, e.g. `ChatGPT`. */
  readonly name?: string;
  readonly driver?: { readonly abilityClaim?: readonly string[] } | null;
  readonly live?: { readonly models?: unknown; readonly catalogName?: unknown } | null;
};

/** One completion connection, its live catalog, and its account. */
export type ModelWire = {
  readonly connection: string;
  readonly name: string;
  readonly choices: readonly ModelChoice[];
  readonly account: WireAccount;
};

const SMALL_CATALOG = 20;

/**
 * Completion connections from kernel connection faces, named as `/connect`
 * names them (live catalog name, then the connection's name, then its id).
 * Catalogs with fewer than 20 ids come first, matching `/model`.
 */
export function completionWires(
  connections: Record<string, ModelCatalogSource | undefined> | null | undefined,
): ModelWire[] {
  const small: ModelWire[] = [];
  const large: ModelWire[] = [];
  if (connections == null) return [];
  for (const [key, spec] of Object.entries(connections)) {
    if (spec == null || !completes(spec)) continue;
    const connection = spec.id.trim() === "" ? key : spec.id;
    const models = modelIds(spec.live?.models);
    if (models.length === 0) continue;
    const name = wireName(spec, connection);
    const wire = {
      connection,
      name,
      choices: models.map((model) => ({ connection, model })),
      account: wireAccount(spec, name),
    };
    (models.length < SMALL_CATALOG ? small : large).push(wire);
  }
  return [...small, ...large];
}

/** A connection as `/connect` names it: live catalog name, then its own name, then its id. */
export function wireName(
  spec: Pick<ModelCatalogSource, "name" | "live"> | null | undefined,
  connection: string,
): string {
  const catalogName = spec?.live?.catalogName;
  const name = (typeof catalogName === "string" ? catalogName.trim() : "") || (spec?.name?.trim() ?? "");
  return name === "" ? connection : name;
}

export function modelChoiceValue(choice: ModelChoice): string {
  return JSON.stringify([choice.connection, choice.model]);
}

/** Dashes become spaces and each word is capitalized. `grok-4.7-build-fast` reads `Grok 4.7 Build Fast`. */
export function naturalName(id: string): string {
  return id
    .split("-")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The model the control names. The session kv wins. When it is empty, the
 * last turn that actually ran a model is what the tape is already showing.
 */
export function sessionModel(
  root: { readonly kvs?: Readonly<Record<string, string>> | null; readonly head?: unknown } | null | undefined,
): ModelChoice {
  const kv = root?.kvs;
  const model = (kv?.model ?? "").trim();
  const connection = (kv?.connection ?? "").trim();
  if (model !== "") return { connection, model };
  return lastTurnModel(root?.head) ?? { connection: "", model: "" };
}

function lastTurnModel(head: unknown): ModelChoice | null {
  const seen = new Set<unknown>();
  let turn: unknown = head;
  while (turn instanceof SessionTurn && !seen.has(turn)) {
    seen.add(turn);
    const chunks = [...turn.doneWork, ...turn.queue];
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const chunk = chunks[i];
      if (!(chunk instanceof CompletionJob)) continue;
      const model = chunk.expectation.model.trim();
      if (model === "") continue;
      return { connection: chunk.expectation.connectionId.trim(), model };
    }
    turn = turn.turnTail;
  }
  return null;
}

function completes(spec: ModelCatalogSource): boolean {
  return spec.driver?.abilityClaim?.includes("completion") ?? false;
}

function modelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (typeof row !== "string") continue;
    const id = row.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
