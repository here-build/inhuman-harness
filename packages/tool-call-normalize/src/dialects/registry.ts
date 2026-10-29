import invariant from "tiny-invariant";

import type { Dialect } from "../types.js";
import { hermesDialect } from "./hermes.js";
import { longcatDialect } from "./longcat.js";
import { openaiDialect } from "./openai-pass.js";
import { qwenXmlDialect } from "./qwen-xml.js";

/** @internal Not re-exported from the package barrel. */
export const dialectRegistry = new Map<string, Dialect>();

export function registerDialect(d: Dialect): void {
  invariant(!dialectRegistry.has(d.id), `dialect already registered: ${d.id}`);
  dialectRegistry.set(d.id, d);
}

export function getDialect(id: string): Dialect | undefined {
  return dialectRegistry.get(id);
}

export function listDialects(): Dialect[] {
  return [...dialectRegistry.values()].sort((a, b) => a.autoPriority - b.autoPriority);
}

export function ensureBuiltins(): void {
  if (dialectRegistry.size > 0) return;
  registerDialect(openaiDialect);
  registerDialect(longcatDialect);
  registerDialect(hermesDialect);
  registerDialect(qwenXmlDialect);
}
