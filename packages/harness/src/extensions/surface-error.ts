import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";

/** A plugin program broke the surface contract. Callers match `message`. */
export class PluginSurfaceError extends ErrorWithInvariant {}
