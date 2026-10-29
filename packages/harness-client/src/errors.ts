import type { UiForm } from "@inhuman.tools/harness-contract";

/** A JSON-RPC error reply. `code` is the JSON-RPC code (-32602 invalid params, -32603 internal, ...). */
export class HarnessRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "HarnessRpcError";
    this.code = code;
    this.data = data;
  }
}

/** The method parked for UI and the client has no `onPark` handler. The park stays open on the daemon until the socket closes. */
export class HarnessParkError extends Error {
  readonly form: UiForm;

  constructor(form: UiForm) {
    super("the call parked for UI and no onPark handler is set");
    this.name = "HarnessParkError";
    this.form = form;
  }
}

/** The connection ended (or was closed) before the call was answered. */
export class HarnessClosedError extends Error {
  constructor(message = "connection closed", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HarnessClosedError";
  }
}
