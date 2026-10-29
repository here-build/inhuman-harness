/**
 * Minimal TEA (The Elm Architecture) types for @quickdraw.
 * Pure functions only — no I/O, no workers.
 */

export type Update<Model, Msg> = (msg: Msg, model: Model) => Model;

/** Monotonic generation counter for snapshots (render drops stale gens). */
export type Generation = number;

export interface Snapshot<Model> {
  gen: Generation;
  model: Model;
  /** wall-clock ms when snapshot was produced (worker) */
  at: number;
}
