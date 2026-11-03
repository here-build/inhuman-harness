import { z } from "zod";

import { createModuleBundle } from "./module-bundle.js";
import type { CompactProgram } from "../session/compact.js";

const snapshotSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  sourcePath: z.string().nullable(),
  resource: z.object({ id: z.string().min(1), revision: z.string().min(1) }).nullable(),
  imports: z.boolean(),
  modules: z.record(z.string(), z.string()),
  failsafe: z.string().nullable(),
});

export type CompactResourceSnapshot = z.infer<typeof snapshotSchema>;

export function snapshotCompactProgram(program: CompactProgram): CompactResourceSnapshot {
  return {
    version: 1,
    source: program.source,
    sourcePath: program.sourcePath,
    resource: program.resource ?? null,
    imports: program.moduleLoader !== undefined,
    modules: {},
    failsafe: program.failsafe ?? null,
  };
}

export function parseCompactSnapshot(json: string): CompactResourceSnapshot {
  return snapshotSchema.parse(JSON.parse(json));
}

/** Recovery uses captured content only; incomplete closures fail rather than loading a newer module. */
export function restoreCompactProgram(snapshot: CompactResourceSnapshot): CompactProgram {
  return {
    source: snapshot.source,
    sourcePath: snapshot.sourcePath,
    ...(snapshot.resource === null ? {} : { resource: snapshot.resource }),
    ...(snapshot.failsafe === null ? {} : { failsafe: snapshot.failsafe }),
    ...(snapshot.imports
      ? {
          moduleLoader: createModuleBundle({
            id: snapshot.resource?.id ?? "compact-snapshot",
            revision: snapshot.resource?.revision ?? "captured",
            modules: snapshot.modules,
          }).loader,
        }
      : {}),
  };
}
