/**
 * Wait-pin copy for the stalls that used to be a blank screen: `/new`
 * (worker swap + three room syncs) and a cold `/model` catalog handshake.
 * Paint already spins a live wait cell; these strings are the status.
 */

export const SPINNER_PHASE = {
  cancelTurn: "cancelling the turn...",
  closingSession: "closing the session...",
  openingSession: "opening the session...",
  syncingSession: "syncing the session...",
  syncingKernel: "syncing the kernel...",
  kernelOccupancy: "reading kernel occupancy...",
  syncingProject: "syncing the project...",
  applyingModel: "applying the model...",
  loadingModels: "loading models...",
} as const;

export type SpinnerPhase = (typeof SPINNER_PHASE)[keyof typeof SPINNER_PHASE];

/** Cold completion wire: interned, handshake not finished, catalog still empty. */
export function coldModelCatalog(input: {
  readonly connectionId: string;
  readonly readyState: string | null;
  readonly modelCount: number;
}): boolean {
  if (input.connectionId.trim() === "") return false;
  if (input.modelCount > 0) return false;
  return input.readyState == null || input.readyState === "bootstrapping";
}
