import type { Readable, Writable } from "node:stream";

import type { SupervisionMessage } from "@/protocol/schemas";
import { decodeSupervisionMessage, encodeSupervisionMessage } from "@/protocol/supervision";

export function writeSupervisionMessage(out: Writable, message: SupervisionMessage): Promise<void> {
  const line = `${encodeSupervisionMessage(message)}\n`;
  return new Promise((resolve, reject) => {
    out.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function readSupervisionMessages(
  input: Readable,
  onMessage: (message: SupervisionMessage) => void,
  onFatal: (error: unknown) => void,
): void {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === "") continue;
      try {
        onMessage(decodeSupervisionMessage(line));
      } catch (error) {
        onFatal(error);
        return;
      }
    }
  });
}
