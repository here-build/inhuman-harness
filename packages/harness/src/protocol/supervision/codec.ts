import { supervisionMessageSchema, type SupervisionMessage } from "../schemas/message.js";

export function encodeSupervisionMessage(message: SupervisionMessage): string {
  return JSON.stringify(supervisionMessageSchema.parse(message));
}

export function decodeSupervisionMessage(raw: unknown): SupervisionMessage {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  return supervisionMessageSchema.parse(value);
}
