/**
 * Layer set of a session, parsed from the JSON the daemon stamps on the root. Memoized by text, so a
 * MobX getter reading it is cheap and sees a new table only when a stamp changes.
 */
import { type AuthorizationConfig, parseAuthorizationConfig } from "./config.js";
import type { Layers } from "./resolve.js";

export type LayerTexts = {
  /** `config.json` `authorization`. */
  readonly user: string;
  /** `<repo>/.inhuman/authorization.json`. Empty: none. */
  readonly project: string;
  /** The human's overlay for this session. Empty: none. */
  readonly session: string;
  /** Deferred. The layering code is ready; nothing ships a managed file yet. */
  readonly managedSet?: string;
  readonly managedRequire?: string;
};

const cache = new Map<string, Layers>();
const CACHE_MAX = 64;

function lenient(text: string | undefined): AuthorizationConfig | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const parsed = parseAuthorizationConfig(text);
  return parsed.ok ? parsed.config : undefined;
}

export function layersOf(texts: LayerTexts): Layers {
  const key = JSON.stringify([
    texts.user,
    texts.project,
    texts.session,
    texts.managedSet ?? "",
    texts.managedRequire ?? "",
  ]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const userText = texts.user.trim();
  const user = userText === "" ? undefined : parseAuthorizationConfig(userText);
  const projectText = texts.project.trim();
  const project = projectText === "" ? undefined : parseAuthorizationConfig(projectText);
  const layers: Layers = {
    session: lenient(texts.session),
    managedSet: lenient(texts.managedSet),
    managedRequire: lenient(texts.managedRequire),
    ...(user === undefined ? {} : user.ok ? { user: user.config } : { userInvalid: true }),
    // A project file that does not parse tightens every cell to a person. It is never ignored.
    ...(project === undefined ? {} : project.ok ? { project: project.config } : { projectInvalid: true }),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, layers);
  return layers;
}

/** Errors of a layer's text, for awareness lines and RPC replies. Empty when it parses. */
export function layerErrors(text: string): readonly string[] {
  const parsed = parseAuthorizationConfig(text);
  return parsed.ok ? [] : parsed.errors;
}
