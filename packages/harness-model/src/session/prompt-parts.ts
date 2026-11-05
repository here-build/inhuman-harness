/**
 * Packets of a system prompt snapshot. Values, not live catalog rows.
 * A session copies these at genesis; a turn overlays a sparse derivation.
 */
import { Model, model, state } from "@inhuman.tools/model";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto } from "../json-record.js";

@model("harness:session:tool-spec")
export class ToolSpec extends Model {
  @state accessor name: string = "";
  @state accessor description: string = "";
  @state accessor argsJson: string | null = "{}";
  @state accessor mutates: boolean = false;

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

  clone(): ToolSpec {
    return new ToolSpec({
      name: this.name,
      description: this.description,
      argsJson: this.argsJson,
      mutates: this.mutates,
    });
  }
}

@model("harness:session:skill-spec")
export class SkillSpec extends Model {
  @state accessor name: string = "";
  @state accessor description: string = "";
  @state accessor location: string = "";
  /** Slash verb. Equals `name` unless a collision forced a qualified id. */
  @state accessor invoke: string = "";

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

  clone(): SkillSpec {
    return new SkillSpec({
      name: this.name,
      description: this.description,
      location: this.location,
      invoke: this.invoke,
    });
  }
}

/** Bare invoke, or `/skill:name` for the nearest skill of that name. */
export function skillMatchesVerb(skill: { readonly name: string; readonly invoke?: string }, verb: string): boolean {
  const invoke = skill.invoke == null || skill.invoke === "" ? skill.name : skill.invoke;
  if (invoke === verb) return true;
  return verb.startsWith("skill:") && verb.slice("skill:".length) === skill.name;
}
