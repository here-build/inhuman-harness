/** Middle-elision knobs for observation array rendering (serializer-elision plan). OPT-IN by
 *  presence — see `ObservationElisionOpts` in `render-observation.ts`, which this mirrors
 *  1:1 (kept as a separate type so substrate's calibration surface doesn't need to import
 *  render-observation just for this shape). `undefined` fields behave exactly as if the knob
 *  were never set. */
export interface ObservationElisionCalibration {
  maxItems?: number;
  topLevelArrayLimit?: number;
  secondLevelArrayLimit?: number;
  elideHead?: number;
  elideTail?: number;
}

/** Tunable numeric constants for the teaching apparatus.
 *
 *  These are the only values with model/harness-specific risk. All mechanisms are driven by
 *  Scheme syntax and arrival-level rules. */
export interface CalibrationOptions {
  /** Top-N candidates for did-you-mean in unbound tool resolution. */
  doorsTier3Top: number;
  /** Whole-call evaluation timeout. */
  defaultEvalTimeoutMs: number;
  /** Character budget for a single rendered observation. */
  observationMaxTotalChars: number;
  /** OPT-IN (see `ObservationElisionCalibration`) — middle-elision knobs for observation array
   *  rendering. Omitted here in `DEFAULT_CALIBRATION`, so every `DoorsRunner` consumer keeps
   *  today's tail-truncation (`+N more of TOTAL`) unchanged unless it explicitly overrides
   *  this field (the manifold does — see arrival-manifold's own calibration wiring). */
  observationElision?: ObservationElisionCalibration;
}

/** Today's hardcoded values, unchanged — the default for every consumer until a calibration
 *  round says otherwise. */
export const DEFAULT_CALIBRATION: CalibrationOptions = {
  doorsTier3Top: 10,
  defaultEvalTimeoutMs: 600_000,
  observationMaxTotalChars: 20_000,
};
