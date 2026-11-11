import type {
  PendingAskRowInsert,
  SessionEffectRowInsert,
  SessionRowInsert,
  SessionTurnRowInsert,
  SessionPatchBatch,
} from "@inhuman.tools/harness-contract";
import type { SerializedDocument, SerializedModelRow } from "@inhuman.tools/model";

export type SerializedSessionDocument = SerializedDocument;
export type NewSessionRow = SessionRowInsert;
export type NewSessionTurnRow = SessionTurnRowInsert;
export type NewPendingAskRow = PendingAskRowInsert;
export type NewSessionEffectRow = SessionEffectRowInsert;

export type SessionCheckpoint = {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly fromRevision: number;
  readonly revision: number;
  readonly rootNodeId: string;
  readonly upsertedNodes: readonly SerializedModelRow[];
  readonly deletedNodeIds: readonly string[];
  readonly sessionRow: Partial<NewSessionRow>;
  readonly dirtyTurns: readonly NewSessionTurnRow[];
  readonly pendingAsks: readonly NewPendingAskRow[];
  readonly patchBatch: SessionPatchBatch;
  readonly effectRecords: readonly NewSessionEffectRow[];
};

export type SessionNodeRestoreState = {
  readonly rootId?: string;
  readonly rows: readonly SerializedModelRow[];
  readonly revision?: number;
  readonly effectRecords?: readonly NewSessionEffectRow[];
  readonly meta?: Record<string, Record<string, unknown>>;
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
