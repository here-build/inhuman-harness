/**
 * Host protocol for minting a persisted connection. Same shape as
 * harness-connections; this package does not import that registry.
 */

export type AdoptCallback = (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>;

export type DriverAdoptArgs = {
  name?: string;
  settings?: Record<string, unknown>;
};

export type DriverAdoptBags = {
  readonly name?: string;
  readonly settings: Record<string, unknown>;
  readonly secrets: Record<string, string>;
};

export function asAdoptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
