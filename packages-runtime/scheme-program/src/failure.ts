import { AgentCallNotification, type ProgrammaticJob } from "@inhuman.tools/harness-model";

export class SchemeReplToolFailure extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "SchemeReplToolFailure";
    this.code = code;
  }
}

export function failureCodeOf(error: unknown): string | undefined {
  let current = error;
  for (let i = 0; i < 6; i++) {
    if (!(current instanceof Error)) return undefined;
    if (current instanceof SchemeReplToolFailure && current.code != null && current.code !== "") {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

export function appendNotify(
  job: ProgrammaticJob,
  host: { readonly notify?: (note: AgentCallNotification) => void },
  message: string,
): void {
  const note = new AgentCallNotification({ message });
  if (host.notify != null) {
    host.notify(note);
    return;
  }
  job.notifications.push(note);
}
