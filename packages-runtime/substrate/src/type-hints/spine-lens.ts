// spine-lens — `createSpineLens(tools): TypeHintLens`, the adapter connecting arrival's
// `createDiagnoseLens` (foundations/arrival/arrival/src/type-layer/diagnose.ts) to this
// package's frozen `TypeHintLens` contract (types.ts). Three things happen here, once per
// `createSpineLens(tools)` call (NOT per `diagnose()` call — the harvested prelude is built
// ONCE and captured):
//
//   1. Recover the bound tools' JSON Schemas from the `BoundTool` registry (bound-tool.ts) —
//      arrival-manifold's original MVP recovery mechanism (an ambient-keyed WeakMap ride-on-
//      ambient handle, `bind.ts`'s `toolSchemasForAmbient`) collapses here into a plain,
//      already-frozen `ReadonlyMap<string, BoundTool>` the caller passes directly: no ambient,
//      no WeakMap, no "does this ambient carry the handle" construction-time check — every
//      `BoundTool` already carries its own `qualifiedName`/`schema`/`outputSchema`.
//   2. Harvest those schemas into an ambient TS prelude via `assembleManifoldPrelude`
//      (json-schema-to-ts.ts) — the tool's ACTUAL declared shape, not the zod-erased
//      `SymbolDef` harvest bind.ts binds into the env (every property there decodes through
//      the scheme-identity codec `z.dynamic`, so it types `unknown` and gives the checker
//      nothing to narrow against — the whole reason this harvest exists).
//   3. Build one `DiagnoseLens` (arrival's whole-program probe) over that prelude, and adapt
//      its `diagnose()` to the frozen `TypeHintLens` shape: async, tuple spans → `SchemeSpan`
//      objects, whitelist-filtered via `HINT_WHITELIST` (arrival's own `codes` option — so a
//      non-whitelisted diagnostic never even pays for payload extraction), otherwise a
//      near-identity field copy (expected/actual stay raw TS type strings — render.ts owns
//      the bifunctor back-translation to scheme-facing prose; only `signatureText` arrives
//      already scheme-facing, since arrival's `signatureToString` never surfaces the internal
//      `_.`-escaped callee name, only its parameter list + return type).
//
// These diagnostics are advisory warnings, never a gate — `diagnose()` only observes a
// throwaway program; select.ts/deliver.ts own every rendering/blocking decision downstream
// of this adapter.

import { createDiagnoseLens } from "@here.build/arrival/type-layer";

import type { BoundTool } from "../bound-tool.js";
import { assembleManifoldPrelude } from "./json-schema-to-ts.js";
import {
  HINT_WHITELIST,
  type LoweredUnit,
  type MappedDiagnostic,
  type SchemeSpan,
  type TypeHintLens,
} from "./types.js";

/** Build the spine adapter over the runner's own bound-tool registry (bound-tool.ts) — the
 *  single per-call-frozen `BoundTool` map every runner already builds, replacing the old
 *  env-keyed WeakMap recovery. Each tool's declared `schema`/`outputSchema` maps directly to
 *  the same `ToolSchemaEntry`-shaped tuple `assembleManifoldPrelude` expects. */
export function createSpineLens(tools: ReadonlyMap<string, BoundTool>): TypeHintLens {
  const toolSchemas: Array<readonly [string, BoundTool["schema"], BoundTool["outputSchema"]]> = [...tools.values()].map(
    (t) => [t.qualifiedName, t.schema, t.outputSchema],
  );
  const harvested = assembleManifoldPrelude(toolSchemas);
  const diag = createDiagnoseLens(harvested);
  const codes = [...HINT_WHITELIST];

  return {
    // synchronous (doc §3: "a whole-program probe over a throwaway ts.Program, no I/O"); the
    // frozen TypeHintLens contract is async so deliver.ts's race treats every lens uniformly.
    async diagnose(programSource, contextDefines) {
      const { unit: rawUnit, diagnostics: rawDiagnostics } = diag.diagnose(programSource, contextDefines, { codes });

      const statementSpans: SchemeSpan[] = rawUnit.statementSpans.map(([start, end]) => ({ start, end }));
      const unit: LoweredUnit = { programStartOffset: rawUnit.programStartOffset, statementSpans };

      const diagnostics: MappedDiagnostic[] = rawDiagnostics.map((d) => ({
        code: d.code,
        span: { start: d.span[0], end: d.span[1] },
        tsMessage: d.tsMessage,
        expected: d.expected,
        actual: d.actual,
        propertyName: d.propertyName,
        candidateProperties: d.candidateProperties,
        signatureText: d.signatureText,
      }));

      return { unit, diagnostics };
    },
  };
}
