/**
 * Agent verb wire names and call-bag schemas. Catalog projections and
 * Scheme bindings share these; they are not builtin executor registrations.
 */

export const AGENT_RESPOND = "agent__respond";
export const AGENT_VOID = "agent__void";
export const AGENT_NOTIFY = "agent__notify";
export const AGENT_MESSAGE = "agent__message";
/** Standing-bot send. Catalog wire; Scheme `bot/send spec message`. */
export const AGENT_SEND = "agent__send";
/** Ask. Catalog wire; Scheme `bot/ask [spec] message` or disposable `agent/ask`. Omitted spec mints AskAgentSpec. */
export const AGENT_ASK = "agent__ask";

/** Autonomous bot-call tools stay host JSON — not Scheme symbols. */
export class AutonomousToolError extends Error {
  constructor(name: string) {
    super(`${name} is a host tool — call it through the API, not from scheme_repl`);
    this.name = "AutonomousToolError";
  }
}
