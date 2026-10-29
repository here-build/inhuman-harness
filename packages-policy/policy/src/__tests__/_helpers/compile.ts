/**
 * Matcher tests bind a Policy directly. The returned Policy is plain functions over the term.
 */
import { bindPolicy } from "../../bind.js";
import type { Which } from "../../identity.js";
import type { Policy } from "../../types.js";

export async function compile(source: unknown, which?: Which): Promise<Policy> {
  return bindPolicy(typeof source === "string" ? JSON.parse(source) : source, which);
}
