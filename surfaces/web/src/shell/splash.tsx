import { useCallback } from "react";
import { SplashBlock, providerRows } from "@inhuman.tools/harness-ui";
import { observer } from "mobx-react-lite";

import { parsePark } from "./connect-park.js";
import { connectPort } from "./connect-step.js";
import { LinkNotice } from "./link-notice.js";
import { useDial } from "../client/context.js";

/** Thin MobX wrapper binding kernel drivers, park parser, and dial link notice into SplashBlock. */
export const Splash = observer(function SplashView() {
  const dial = useDial();
  const rows = providerRows(dial.kernel?.root.drivers, dial.kernel?.root.connections);
  // A line that is down or redialing takes no writes, as the composer does not.
  const request = dial.link == null ? connectPort(dial) : null;
  const onDriversFocus = useCallback((drivers: readonly string[]) => dial.look([], drivers), [dial]);

  return (
    <SplashBlock
      rows={rows}
      request={request}
      parsePark={parsePark}
      notice={<LinkNotice />}
      onDriversFocus={onDriversFocus}
    />
  );
});
