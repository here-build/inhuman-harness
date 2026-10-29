/**
 * Admission descriptor on an unattended turn. Null on the host turn is the
 * interactive default — this object exists only when a program was admitted.
 * Policy here is the unattended tri-state value (`auto` | `yolo`), not `permissionMode`.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import type { EvalPermissionMode } from "../eval-context.js";

@syncing("harness:session:turn-eval-spec")
export class SessionTurnEvalSpec extends PlexusModel {
  @syncing accessor requestId: string = "";
  @syncing accessor permissionMode: EvalPermissionMode = "auto";

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
