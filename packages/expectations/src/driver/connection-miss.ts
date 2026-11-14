/**
 * Intern / send-ready miss. Remainder maps `noconnect` → writeFail("no model connection").
 * Honor fallback (one release) catches only this class.
 */
export class ConnectionMiss extends Error {
  readonly code: "noconnect" | "not-ready" | "needs-auth" | "connection-dropped";

  constructor(code: ConnectionMiss["code"], message?: string) {
    super(message ?? code);
    this.name = "ConnectionMiss";
    this.code = code;
  }
}
