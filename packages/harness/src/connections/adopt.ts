/**
 * Host protocol: mint a persisted connection from a driver class.
 *
 * PEWDriver does not declare this. Drivers that need a conversation
 * implement `static adopt`; {@link adoptDriver} passthroughs settings when
 * the method is absent.
 *
 * `callback("UI", scheme)` parks on the kernel JSON-RPC host and resumes
 * with the answer. Not an elicit protocol.
 */

export type AdoptCallback = (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>;

export type DriverAdoptArgs = {
  name?: string;
  settings?: Record<string, unknown>;
  /** The adopt request's abort: a client cancel while the driver waits on a browser. */
  signal?: AbortSignal;
  /** Secrets the caller already holds (`connect/adopt` with `secrets`): a driver does not ask for them again. */
  secrets?: Readonly<Record<string, string>>;
};

export type DriverAdoptBags = {
  readonly name?: string;
  readonly settings: Record<string, unknown>;
  readonly secrets: Record<string, string>;
};

type AdoptFn = (args: DriverAdoptArgs, callback: AdoptCallback) => DriverAdoptBags | Promise<DriverAdoptBags>;

export async function adoptDriver(
  connectionClass: object,
  args: DriverAdoptArgs,
  callback: AdoptCallback,
): Promise<DriverAdoptBags> {
  const adopt = (connectionClass as { adopt?: AdoptFn }).adopt;
  if (typeof adopt === "function") return adopt.call(connectionClass, args, callback);
  return { settings: { ...(args.settings ?? {}) }, secrets: {} };
}
