/**
 * Shared types + constants. Union law: every model union has an `x-plugin`
 * escape or says why not.
 */

/**
 * On-disk shape of harness:* entities. Bump only for breaking materialization.
 * Additive PEW fields keep empty defaults — do not bump: single major;
 * inequality world-stops coexistence.
 */
export const SCHEMA_VERSION = 8;

/**
 * Plugins propose, never apply. Form-keyed; vocabulary SSOT: `policy/dispose-series.ts`.
 */
export type KvProposal =
  | { readonly form: "kv-set"; readonly key: string; readonly value: string }
  | { readonly form: "kv-clear"; readonly key: string };
