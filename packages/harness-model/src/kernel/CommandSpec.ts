/**
 * Slash catalog row on the kernel image. Verb is the parent record key.
 * Membership is the yaml / plugin.json declaration. `source` is the
 * importPath pointer. `body` is the command file, not a catalog column.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import type { KernelRoot } from "./KernelRoot.js";
import type { ProjectRoot } from "./ProjectRoot.js";

@syncing("harness:command-spec")
export class CommandSpec extends PlexusModel<KernelRoot | ProjectRoot | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.verb;
  }

  @syncing accessor verb: string = "";
  @syncing accessor description: string = "";
  @syncing.list accessor aliases: string[] = [];
  @syncing accessor source: string = "";
  @syncing accessor body: string = "";
}
