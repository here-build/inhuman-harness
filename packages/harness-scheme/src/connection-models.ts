/**
 * Live model ids on a connection, and `connection/model` parse.
 * One-shot `:model` and scheme_repl faces use the same ref.
 */

import type { ConnectionSpec } from "@inhuman.tools/plexus-expectations";

export type CompletionFace = {
  readonly id: string;
  readonly models: readonly string[];
};

export type SchemeReplFaces = {
  readonly connections: readonly CompletionFace[];
  readonly modelsUsage: Readonly<Record<string, number>>;
};

export function liveModelsOf(spec: ConnectionSpec): string[] {
  const raw = spec.live.models;
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => String(row).trim()).filter((id) => id !== "");
}

export function parseModelRef(raw: string): { readonly connection: string; readonly model: string } | undefined {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { connection: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

export function oneShotModelError(ref: string, connections: Record<string, ConnectionSpec | undefined>): string {
  const parsed = parseModelRef(ref);
  if (parsed == null) return 'model must be "connection/model"';
  const spec = connections[parsed.connection];
  if (spec == null) return `unknown connection ${parsed.connection}`;
  if (!spec.driver.abilityClaim.includes("completion")) return `${parsed.connection} is not a completion connection`;
  if (!liveModelsOf(spec).includes(parsed.model)) return `unknown model ${parsed.model} on ${parsed.connection}`;
  return "";
}
