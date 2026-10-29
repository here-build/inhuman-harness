/**
 * Named daemon action on the kernel image. Key = action name.
 * Thinkable spec — the daemon binds and runs it; the replica does not.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

@syncing("harness:action-spec")
export class ActionSpec extends PlexusModel<PlexusModel<null> | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.name;
  }

  @syncing accessor name: string = "";
  @syncing accessor description: string = "";
  @syncing accessor seat: "session" | "harness" = "session";
  @syncing accessor source: string = "";
  @syncing accessor body: string = "";
}
