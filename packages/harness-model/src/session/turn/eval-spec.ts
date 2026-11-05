/**
 * Admission descriptor on an unattended turn. Null on the host turn is the
 * interactive default — this object exists only when a program was admitted.
 * Policy here is the unattended tri-state value (`auto` | `yolo`), not `permissionMode`.
 */
import { Model, model, state } from "@inhuman.tools/model";

import type { EvalPermissionMode } from "../eval-context.js";

@model("harness:session:turn-eval-spec")
export class SessionTurnEvalSpec extends Model {
  @state accessor requestId: string = "";
  @state accessor permissionMode: EvalPermissionMode = "auto";

  constructor(
    props?:
      | {
          readonly requestId?: string;
          readonly permissionMode?: EvalPermissionMode;
        }
      | symbol,
  ) {
    super(props);
  }
}
