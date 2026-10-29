import { useCallback, useRef } from "react";
import { useFocusEffect } from "@react-navigation/native";

import { useDial } from "./dial-context.js";
import type { RouteTarget } from "../../harness-web-app/src/shell/path.js";

function targetKey(target: RouteTarget): string {
  switch (target.kind) {
    case "kernel":
      return "kernel";
    case "project":
      return `project:${target.path}`;
    case "session":
      return `session:${target.sessionId}`;
    case "project-session":
      return `project-session:${target.path}:${target.sessionId}`;
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

/**
 * Follow while this screen is focused. Do not abort on blur: `Dial.follow` records
 * `cancelled` when the signal aborts, including after the rooms have already committed.
 */
export function useFollow(target: RouteTarget): void {
  const dial = useDial();
  const key = targetKey(target);
  const current = useRef(target);
  current.current = target;
  useFocusEffect(
    useCallback(() => {
      void dial.follow(current.current);
    }, [dial, key]),
  );
}
