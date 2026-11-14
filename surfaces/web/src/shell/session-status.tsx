import type { SessionActivity, SessionRoot } from "@inhuman.tools/harness-model";
import { observer } from "mobx-react-lite";

import { autoModeProblem } from "./auto-mode-health.js";
import { useDial } from "../client/context.js";

const LABELS: Readonly<Record<Exclude<SessionActivity["kind"], "stopped">, string>> = {
  idle: "Ready",
  stopping: "Stopping",
  approval: "Waiting for your approval",
  tools: "Using tools",
  agents: "Waiting for agents",
  compacting: "Compacting context",
  working: "Working",
  waiting: "Waiting for model",
  thinking: "Thinking",
  responding: "Responding",
  retrying: "Waiting to retry",
  checking: "Checking with judge",
};

export const SessionStatus = observer(function SessionStatusView({
  session: root,
}: {
  readonly session: SessionRoot | null;
}) {
  const dial = useDial();
  if (root == null) return null;
  const activity: SessionActivity = root.activity ?? { kind: "idle" };
  const problem = root.permissionMode === "auto" ? autoModeProblem(root, dial.kernel?.root) : null;
  const completion = "completion" in activity ? activity.completion : null;
  const failures = completion == null ? 0 : completion.foregroundFailures + completion.backgroundFailures;
  const count = completion?.retryForeground ? completion.foregroundFailures : (completion?.backgroundFailures ?? 0);
  const limit = completion?.retryForeground
    ? completion.retryMaxAttempts
    : (completion?.retryBackgroundMaxAttempts ?? 0);
  if (activity.kind === "idle" && problem == null) return null;
  return (
    <div className="session-status" role="status" aria-label="Session activity" aria-live="polite" aria-atomic="true">
      <div className="session-status-line" data-problem={activity.kind === "stopped" || problem != null || undefined}>
        <span>{activity.kind === "stopped" ? "Turn stopped" : LABELS[activity.kind]}</span>
        {failures === 0 ? null : (
          <span className="session-status-attempts">
            {count}
            {limit === 0 ? "" : ` / ${limit}`} unsuccessful {completion?.retryForeground ? "foreground" : "background"}{" "}
            attempts
          </span>
        )}
      </div>
      {activity.kind !== "stopped" ? null : <p className="session-status-problem">{activity.detail}</p>}
      {completion?.lastAttemptError ? (
        <details className="session-status-error">
          <summary>Last model request failed</summary>
          <p>{completion.lastAttemptError}</p>
        </details>
      ) : null}
      {problem == null ? null : (
        <details className="session-status-error">
          <summary>Auto unavailable</summary>
          <p>{problem}</p>
        </details>
      )}
    </div>
  );
});
