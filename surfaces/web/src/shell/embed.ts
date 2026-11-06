/** The iPhone client loads the session page with the browser frame removed. */
export type Embed = {
  readonly active: boolean;
  /** Points. The page clears the native bar by this much. */
  readonly safeTop: number;
  readonly safeBottom: number;
};

const MAX_INSET = 200;

function inset(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_INSET) return 0;
  return Math.round(parsed);
}

/** `?embed=1&safeTop=96`. Anything else is the full browser shell. */
export function readEmbed(search: string): Embed {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    active: params.get("embed") === "1",
    safeTop: inset(params.get("safeTop")),
    safeBottom: inset(params.get("safeBottom")),
  };
}
