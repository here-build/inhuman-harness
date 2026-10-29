/**
 * cli-chat-proxy 426s when `x-grok-client-version` is below its floor.
 * The number below is the lockstepped `xai-grok-version` crate. A stored
 * `clientVersion` wins when it is newer. A 426 replaces either with whatever
 * that crate currently publishes.
 */
import { z } from "zod";

/** Floor advertised when settings have no newer clientVersion. */
export const GROK_CLIENT_VERSION = "1.0.45";

/** Lockstepped crate. The proxy's own 426 text only names its minimum. */
export const GROK_VERSION_SOURCE =
  "https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-version/Cargo.toml";

const storedSettings = z.looseObject({
  clientVersion: z.unknown().optional(),
});

const versionLine = /^version\s*=\s*["'](\d+\.\d+\.\d+)["']\s*$/m;

export function chooseClientVersion(settings: unknown): { readonly version: string; readonly persist: boolean } {
  const bag = storedSettings.safeParse(settings);
  const stored = bag.success ? versionText(bag.data.clientVersion) : null;
  const version =
    stored != null && compareClientVersion(stored, GROK_CLIENT_VERSION) > 0 ? stored : GROK_CLIENT_VERSION;
  return { version, persist: stored !== version };
}

/** Negative when `left` is older. Unparseable sides compare equal so a bad crate file cannot move the pin. */
export function compareClientVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a == null || b == null) return 0;
  const delta = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (delta > 0) return 1;
  if (delta < 0) return -1;
  return 0;
}

export async function fetchPublishedGrokVersion(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(GROK_VERSION_SOURCE, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return parseLocksteppedVersion(await res.text());
  } catch {
    return null;
  }
}

function versionText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return versionParts(text) == null ? null : text;
}

function versionParts(version: string): [number, number, number] | null {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (matched == null) return null;
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}

function parseLocksteppedVersion(toml: string): string | null {
  const table = toml.split(/\n(?=\[)/).find((block) => block.trimStart().startsWith("[package]"));
  if (table == null) return null;
  const raw = versionLine.exec(table)?.[1];
  return raw == null ? null : versionText(raw);
}
