/**
 * Slash catalog row on the kernel image. Verb is the parent record key.
 * Membership is the yaml / plugin.json declaration. `source` is the
 * importPath pointer. `body` is the command file, not a catalog column.
 */
import { Model, model, state } from "@inhuman.tools/model";

import type { KernelRoot } from "./KernelRoot.js";
import type { ProjectRoot } from "./ProjectRoot.js";

@model("harness:command-spec")
export class CommandSpec extends Model<any, KernelRoot | ProjectRoot | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.verb;
  }

  @state accessor verb: string = "";
  @state accessor description: string = "";
  @state.list accessor aliases: string[] = [];
  @state accessor source: string = "";
  @state accessor body: string = "";
}
