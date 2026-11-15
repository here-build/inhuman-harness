import type { SessionRoot } from "@inhuman.tools/harness-model";
import { projectSessionStatus } from "@inhuman.tools/harness-transcript/names";
import { SessionStatusBlock } from "@inhuman.tools/harness-ui/blocks/session-status-block";
import { observer } from "mobx-react-lite";

import { useDial } from "../client/context.js";

/** Reactive host adapter projecting session activity and retry failures into {@link SessionStatusBlock}. */
export const SessionStatus = observer(function SessionStatusView({
  session: root,
}: {
  readonly session: SessionRoot | null;
}) {
  const dial = useDial();
  const props = projectSessionStatus(root, dial.kernel?.root);
  return props == null ? null : <SessionStatusBlock {...props} />;
});
