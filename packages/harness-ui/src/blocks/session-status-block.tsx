import { cn } from "../lib/cn.js";

export interface SessionStatusBlockProps {
  /** Human-readable activity or stopped status label. */
  readonly label: string;
  /** Optional retry progress summary text (e.g. "2 / 5 unsuccessful foreground attempts"). */
  readonly attemptsText?: string;
  /** Detail message displayed when the turn stopped due to an error. */
  readonly stopDetail?: string;
  /** Expandable summary and detail for the latest failed model attempt. */
  readonly lastAttemptError?: string;
  readonly lastAttemptSummary?: string;
  /** Expandable summary and detail for workspace/policy problems (e.g. auto-mode health). */
  readonly problemSummary?: string;
  readonly problemDetail?: string | null;
  readonly isProblem?: boolean;
  readonly ariaLabel?: string;
  readonly className?: string;
}

/** Live session activity, retry counter, and failure disclosure strip. */
export function SessionStatusBlock({
  label,
  attemptsText,
  stopDetail,
  lastAttemptError,
  lastAttemptSummary = "Last model request failed",
  problemSummary = "Auto unavailable",
  problemDetail,
  isProblem = false,
  ariaLabel = "Session activity",
  className,
}: SessionStatusBlockProps) {
  return (
    <div
      className={cn("session-status", className)}
      role="status"
      aria-label={ariaLabel}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="session-status-line" data-problem={isProblem || undefined}>
        <span>{label}</span>
        {attemptsText == null ? null : <span className="session-status-attempts">{attemptsText}</span>}
      </div>
      {stopDetail == null ? null : <p className="session-status-problem">{stopDetail}</p>}
      {lastAttemptError ? (
        <details className="session-status-error">
          <summary>{lastAttemptSummary}</summary>
          <p>{lastAttemptError}</p>
        </details>
      ) : null}
      {problemDetail == null ? null : (
        <details className="session-status-error">
          <summary>{problemSummary}</summary>
          <p>{problemDetail}</p>
        </details>
      )}
    </div>
  );
}
