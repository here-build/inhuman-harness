/**
 * Open shader registry. Programs register with renderFrame (node GL / worker).
 *
 *   registerBgFxShader({ id: "mine", renderFrame: ... })
 *   fillBgFx(buf, rect, "mine")
 */

import invariant from "tiny-invariant";

import type { BgFxId, BgFxProgram } from "./types.js";

const registry = new Map<BgFxId, BgFxProgram>();

/** Register or replace a color-field program. */
export function registerBgFxShader(program: BgFxProgram): void {
  invariant(program.id, "bgFx program requires non-empty id");
  invariant(program.renderFrame, `bgFx program "${program.id}" needs renderFrame`);
  registry.set(program.id, program);
}

export function unregisterBgFxShader(id: BgFxId): boolean {
  return registry.delete(id);
}

export function getBgFxShader(id: BgFxId): BgFxProgram | undefined {
  return registry.get(id);
}

export function hasBgFxShader(id: BgFxId): boolean {
  return registry.has(id);
}
