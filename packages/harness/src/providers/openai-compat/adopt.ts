/**
 * Host protocol: mint a persisted connection from a driver class.
 *
 * `callback("UI", scheme)` parks on the kernel JSON-RPC host and resumes
 * with the answer. Not an elicit protocol.
 */

export type AdoptCallback = (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>;

export type DriverAdoptArgs = {
  name?: string;
  settings?: Record<string, unknown>;
  signal?: AbortSignal;
  secrets?: Readonly<Record<string, string>>;
};

export type DriverAdoptBags = {
  readonly name?: string;
  readonly settings: Record<string, unknown>;
  readonly secrets: Record<string, string>;
};

export function asAdoptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
