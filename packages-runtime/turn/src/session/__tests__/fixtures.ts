import { asUserPrompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import { HARNESS_CONSTITUTION, SessionDocument, SessionTurn } from "@inhuman.tools/harness-model";
import { onTestFinished } from "vitest";

import type { CallsCatalog } from "../../agent-calls/index.js";
import { KernelToolCatalog } from "../../tool-catalog/index.js";
import type { SessionCommandHost } from "../types.js";

export function sessionOf(id: string): SessionDocument {
  const doc = SessionDocument.create(id, `/tmp/session-runtime/${id}`);
  onTestFinished(() => doc.destroy());
  return doc;
}

export function emptyCatalog(): CallsCatalog {
  const table = new KernelToolCatalog();
  onTestFinished(() => table[Symbol.dispose]());
  return {
    catalogEntry: (name) => table.catalogEntry(name),
    botRevisions: table.botRevisions,
  };
}

export function commandHost(doc: SessionDocument, extra: Partial<SessionCommandHost> = {}): SessionCommandHost {
  const cancelled: SessionTurn[] = [];
  return {
    session: doc.root,
    constitution: HARNESS_CONSTITUTION,
    env: () => ({ cwd: doc.root.path }),
    toolsFor: () => null,
    queuedVerbs: () => new Set(),
    cancelOwned: (turn) => {
      cancelled.push(turn);
      turn.cancelRequested = true;
    },
    log: () => undefined,
    ...extra,
  };
}

export function user(text: string): UserPrompt {
  return asUserPrompt(text);
}
