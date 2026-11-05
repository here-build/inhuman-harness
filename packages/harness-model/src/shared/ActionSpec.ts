/**
 * Named daemon action on the kernel image. Key = action name.
 * Thinkable spec — the daemon binds and runs it; the replica does not.
 */
import { Model, model, state } from "@inhuman.tools/model";

@model("harness:action-spec")
export class ActionSpec extends Model<any, Model | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.name;
  }

  @state accessor name: string = "";
  @state accessor description: string = "";
  @state accessor seat: "session" | "harness" = "session";
  @state accessor source: string = "";
  @state accessor body: string = "";
}
