/**
 * Packets of a system prompt snapshot. Values, not live catalog rows.
 * A session copies these at genesis; a turn overlays a sparse derivation.
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto } from "../json-record.js";

@syncing("harness:session:tool-spec")
export class ToolSpec extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor description: string = "";
  @syncing accessor argsJson: string | null = "{}";
  @syncing accessor mutates: boolean = false;

  constructor(
    props?:
      | {
          readonly name?: string;
          readonly description?: string;
          readonly argsJson?: string | null;
          readonly mutates?: boolean;
        }
      | symbol,
  ) {
    super(props);
  }

  /** JSON Schema for this tool. Not call arguments. */
  @serializingInto("argsJson")
  accessor parameters: ReadonlyDeep<Record<string, unknown>> | null = null;
}

@syncing("harness:session:skill-spec")
export class SkillSpec extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor description: string = "";
  @syncing accessor location: string = "";
  /** Slash verb. Equals `name` unless a collision forced a qualified id. */
  @syncing accessor invoke: string = "";

  constructor(
    props?:
      | {
          readonly name?: string;
          readonly description?: string;
          readonly location?: string;
          readonly invoke?: string;
        }
      | symbol,
  ) {
    super(props);
  }
}

/** Bare invoke, or `/skill:name` for the nearest skill of that name. */
export function skillMatchesVerb(skill: { readonly name: string; readonly invoke?: string }, verb: string): boolean {
  const invoke = skill.invoke == null || skill.invoke === "" ? skill.name : skill.invoke;
  if (invoke === verb) return true;
  return verb.startsWith("skill:") && verb.slice("skill:".length) === skill.name;
}
