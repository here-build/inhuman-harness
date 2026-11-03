import type { PromptMessage, PromptMessageRole } from "@inhuman.tools/harness-model/session";

export type RuntimeLoopNote = {
  readonly id: string;
  readonly text: string;
  readonly mode: "ambient" | "activating";
};

export interface RuntimeNoteLog {
  peek(sessionId: string): readonly RuntimeLoopNote[];
  consume(sessionId: string, ids: readonly string[], callId: string): void;
}

export type TurnSettle =
  { readonly ok: true; readonly value: string | false } | { readonly ok: false; readonly error: string };

export interface RuntimeDiagnostics {
  step?(message: string): void;
  trace?(namespace: string, message: string): void;
  fail?(label: string, error: unknown): void;
}

export type PromptTextStamp =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "blob"; readonly head: string; readonly blobJson: string };

export type PromptTextExternalizer = (text: string) => PromptTextStamp;
export type PromptMessageFactory = (role: PromptMessageRole, text: string) => PromptMessage;
