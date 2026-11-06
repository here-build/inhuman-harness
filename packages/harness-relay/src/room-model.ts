import { Model, model, state } from "@inhuman.tools/model";

@model("harness:relay:room")
export class RelayRoomRoot extends Model {
  @state.record accessor m: Record<string, unknown> = {};
}
