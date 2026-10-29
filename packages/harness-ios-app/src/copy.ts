/** What the phone says. The browser's unreachable line names `harness daemon start`; this client only has `harness web`. */

export const DAEMON_UNREACHABLE = "Can’t reach the harness daemon. Start harness web on this Mac, then retry.";

export const DAEMON_UNANSWERED = "The daemon didn’t answer in time.";

export const RECONNECTING = "Reconnecting to the daemon… It hasn’t answered yet.";

export const ONBOARDING = "Connect a model before starting a session.";

export const CONNECT_MODEL = "Connect a model";

export const NO_PROJECTS = "No projects yet.";

export const NO_PROJECTS_DETAIL = "Run harness in a directory on this Mac.";

export const NOTHING_WAITING = "Nothing needs you.";

export const NO_SESSIONS = "No sessions yet.";

export const NO_MATCH = "No sessions match.";

export const NO_PROJECT_MATCH = "No projects match.";

export const ATTACHING = "Attaching…";

export const OPENING = "Opening the workspace…";

export const OPENING_SESSION = "Opening the session…";

export const NO_MESSAGES = "No messages yet.";

export const NO_MESSAGES_DETAIL = "Ask or describe a change below.";

export const TURN_RUNNING = "A turn is still running. Stop it to send.";

export const ANSWER_SHORTLY = "You can answer in a moment.";

export function linkSentence(kind: string): string | null {
  switch (kind) {
    case "unreachable":
      return DAEMON_UNREACHABLE;
    case "unanswered":
      return DAEMON_UNANSWERED;
    case "reconnecting":
      return RECONNECTING;
    case "missing":
      return "There is no session at this link.";
    case "cancelled":
      return "Opening was cancelled.";
    case "elsewhere":
      return "This session opened in another project.";
    default:
      return null;
  }
}

export const DAEMON_WHERE =
  "The daemon runs on your Mac. Start harness web there (by default it listens on 127.0.0.1:8787), then retry.";
