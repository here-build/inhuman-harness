import type { ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { observer } from "mobx-react-lite";

import { looseSessionHref, projectHref, projectNames, sessionHref } from "./path.js";
import { useDial } from "../client/context.js";
import type { Link } from "../client/dial.js";
import { Button } from "../components/ui/button.js";

/**
 * The line to the daemon, in one sentence and at most one action. A state the
 * system resolves on its own breathes; a state that needs you rings, as a
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
      <Waiting>
        {target === "kernel"
          ? "Opening the workspace…"
          : target === "project"
            ? "Opening the project…"
            : "Opening the session…"}
      </Waiting>
    );
  }
  if (link.kind === "reconnecting") {
    return (
      <Waiting>
        Reconnecting to the daemon…<span className="link-later"> It hasn’t answered yet.</span>
      </Waiting>
    );
  }
  if (link.kind === "offline" && link.redialing) {
    return (
      <Waiting>
        This machine is offline.<span className="link-later"> Waiting for it to come back.</span>
      </Waiting>
    );
  }
  const go = (href: string) => () => void router.navigate({ href });
  const retry = () => void dial.follow(dial.requestedTarget);
  const { text, action, onAction } = needs(link, dial, go, retry);
  return (
    <p className="link-notice" role="status">
      <span className="link-glyph" data-needs="" aria-hidden />
      <span className="link-text">{text}</span>
      <Button variant="secondary" disabled={dial.attaching} onClick={onAction}>
        {action}
      </Button>
    </p>
  );
});

function Waiting({ children }: { readonly children: ReactNode }) {
  return (
    <p className="link-notice" data-waiting="" role="status">
      <span className="link-glyph" data-waiting="" aria-hidden />
      <span className="link-text">{children}</span>
    </p>
  );
}

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
      // A global session has no project: it opens on its own.
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
            This session belongs to <span className="mono">{name}</span>.
          </>
        ),
        action: "Open it there",
        onAction: go(sessionHref(link.path, link.sessionId)),
      };
    }
  }
}
