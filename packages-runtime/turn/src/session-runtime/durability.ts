export type SessionCheckpoint = {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly state: Uint8Array;
};

export type SessionReceipt = {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly revision: number;
};

export type SessionDurability =
  | { readonly kind: "memory" }
  | {
      readonly kind: "durable";
      commit(checkpoint: SessionCheckpoint): Promise<SessionReceipt>;
    };

export function receiptCovers(receipt: SessionReceipt, checkpoint: SessionCheckpoint): boolean {
  return (
    receipt.sessionId === checkpoint.sessionId &&
    receipt.incarnation === checkpoint.incarnation &&
    receipt.revision >= checkpoint.revision
  );
}

export class SessionPersistenceError extends Error {
  constructor(message = "session checkpoint was not durably acknowledged") {
    super(message);
    this.name = "SessionPersistenceError";
  }
}

export class SessionOwnershipError extends Error {
  constructor(message = "session execution no longer owns this document") {
    super(message);
    this.name = "SessionOwnershipError";
  }
}
