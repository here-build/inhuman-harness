/**
 * Live tools[] face for a session root.
 *
 * Product composition binds the session view (worker ceilings, blocklist,
 * behavior, private MCP) plus any live description overlay. Frozen turn
 * tools stay as snapshotted. Session and Scheme runtimes stay out of this
 * package.
 */
import { catalogOf, type KernelToolCatalog } from "@/tool-catalog";

export type LiveToolDescription = (toolName: string, catalog: KernelToolCatalog) => string | undefined;

export type CompletionFace = {
  catalog(): KernelToolCatalog | undefined;
  liveDescription?: LiveToolDescription;
};

const facesByRoot = new WeakMap<object, CompletionFace>();

export function bindCompletionFace(root: object, face: CompletionFace): void {
  facesByRoot.set(root, face);
}

export function completionCatalogOf(root: object | undefined | null): KernelToolCatalog | undefined {
  if (root != null) {
    const face = facesByRoot.get(root);
    if (face !== undefined) return face.catalog();
  }
  return catalogOf(root);
}

export function liveToolDescriptionOf(
  root: object | undefined | null,
  toolName: string,
  catalog: KernelToolCatalog,
): string | undefined {
  if (root == null) return undefined;
  return facesByRoot.get(root)?.liveDescription?.(toolName, catalog);
}
