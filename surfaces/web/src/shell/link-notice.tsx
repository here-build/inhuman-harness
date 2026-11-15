import type { ReactNode } from "react";
import { LinkNoticeBlock } from "@inhuman.tools/harness-ui/blocks/link-notice-block";
import { useRouter } from "@tanstack/react-router";
import { observer } from "mobx-react-lite";

import { looseSessionHref, projectHref, projectNames, sessionHref } from "./path.js";
import { useDial } from "../client/context.js";
import type { Link } from "../client/dial.js";

/**
 * The line to the daemon, in one sentence and at most one action. A state the
 * system resolves on its own keeps a steady marker; a state that needs you has a boundary, as a
 * sidebar row does when it waits on you. Opening shows only past a beat, and
 * a redial says it is still trying only when it is.
 */
export const LinkNotice = observer(function LinkNoticeView() {
  const dial = useDial();
  const router = useRouter();
  const link = dial.link;
  if (link == null) {
    if (!dial.attaching) return null;
    const target = dial.requestedTarget.kind;
    return (
      <LinkNoticeBlock
        mode="waiting"
        message={
          target === "kernel"
            ? "Opening the workspace…"
            : target === "project"
              ? "Opening the project…"
              : "Opening the session…"
        }
      />
    );
  }
  if (link.kind === "reconnecting") {
    return (
      <LinkNoticeBlock
        mode="waiting"
        message={
          <>
            Reconnecting to the daemon…<span className="link-later"> It hasn’t answered yet.</span>
          </>
        }
      />
    );
  }
  if (link.kind === "offline" && link.redialing) {
    return (
      <LinkNoticeBlock
        mode="waiting"
        message={
          <>
            This machine is offline.<span className="link-later"> Waiting for it to come back.</span>
          </>
        }
      />
    );
  }
  const go = (href: string) => () => void router.navigate({ href });
  const retry = () => void dial.follow(dial.requestedTarget);
  const { text, action, onAction } = needs(link, dial, go, retry);
  return (
    <LinkNoticeBlock
      mode="needs"
      message={text}
      actionLabel={action}
      actionDisabled={dial.attaching}
      onAction={onAction}
    />
  );
});

type Need = { readonly text: ReactNode; readonly action: string; readonly onAction: () => void };

function needs(
  link: Exclude<Link, { kind: "reconnecting" } | { kind: "offline"; redialing: true }>,
  dial: ReturnType<typeof useDial>,
  go: (href: string) => () => void,
  retry: () => void,
): Need {
  switch (link.kind) {
    case "unreachable":
      return {
        text: (
          <>
            Can’t reach the harness daemon. Start it with <code>inhuman daemon start</code>, then retry.
          </>
        ),
        action: "Retry",
        onAction: retry,
      };
    case "offline":
      return { text: "This machine is offline.", action: "Retry", onAction: retry };
    case "unavailable":
      return {
        text: link.reason === "" ? "The machine can’t open this." : `The machine can’t open this: ${link.reason}.`,
        action: "Retry",
        onAction: retry,
      };
    case "unanswered":
      return { text: "The daemon didn’t answer in time.", action: "Retry", onAction: retry };
    case "cancelled":
      return { text: "Opening was cancelled.", action: "Retry", onAction: retry };
    case "missing": {
      const target = dial.requestedTarget;
      const path = target.kind === "project-session" ? target.path : null;
      return path == null
        ? { text: "There is no session at this link.", action: "Open the workspace", onAction: go("/") }
        : { text: "There is no session at this link.", action: "Open the project", onAction: go(projectHref(path)) };
    }
    case "elsewhere": {
      if (link.path === "") {
        return {
          text: "This session is not part of a project.",
          action: "Open it on its own",
          onAction: go(looseSessionHref(link.sessionId)),
        };
      }
      const name = projectNames(Object.keys(dial.kernel?.root.projects ?? {})).get(link.path) ?? link.path;
      return {
        text: (
          <>
            This session belongs to <span>{name}</span>.
          </>
        ),
        action: "Open it there",
        onAction: go(sessionHref(link.path, link.sessionId)),
      };
    }
  }
}
