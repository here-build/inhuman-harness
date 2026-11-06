/**
 * Wait pin above the composer, chosen from plexus facts.
 *
 * Host phase (opening, syncing, applying the model) is a present sentence
 * written by the host, not a session fact, so it is not an arm here.
 * The retry countdown needs a clock. `retryUntilMs` stays on the chrome
 * and the widget formats it.
 *
 * A reader runs only while its arm is still open. Reading every fact up
 * front would subscribe the paint stamp to edits the pin does not show.
 */
import type { EmptyWaitChrome } from "@inhuman.tools/harness-sdk/text";

import type { OmniboxLayer } from "./omnibox-seat.js";
import type { WaitPinChrome } from "./paint-controller.js";
import { coldModelCatalog, SPINNER_PHASE } from "./spinner-phase.js";

export type WaitPhraseReaders = {
  seat(): OmniboxLayer;
  historyHides(): boolean;
  ask(): boolean;
  occupancy(): EmptyWaitChrome | null;
  /** Processing, and a turn is still running. */
  cancel(): boolean;
  catalog(): {
    readonly connectionId: string;
    readonly readyState: string | null;
    readonly modelCount: number;
  };
  slash(): string | null;
  error(): string;
};

export function waitPhrase(read: WaitPhraseReaders): WaitPinChrome | null {
  const seat = read.seat();
  if (seat === "auth" || seat === "overlay") return null;
  if (read.historyHides()) return null;
  if (read.ask()) return null;
  const occupancy = read.occupancy();
  if (occupancy != null) return { occupancy, error: read.error() };
  const error = read.error();
  if (read.cancel()) return { occupancy: waitingStall(SPINNER_PHASE.cancelTurn), error };
  if (coldModelCatalog(read.catalog()) && read.slash() === "model") {
    return { occupancy: waitingStall(SPINNER_PHASE.loadingModels), error };
  }
  if (error === "") return null;
  return { occupancy: null, error };
}

function waitingStall(label: string): EmptyWaitChrome {
  return { kind: "waiting", label, elapsed: false, startedAt: null, retryUntilMs: null };
}
