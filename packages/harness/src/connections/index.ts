/**
 * @/connections — registered driver resolver and
 * PEW intern adapter for adopt, discovery, and execution.
 *
 * One intern table (PEW). No vendor providers, no plugin loader.
 */

export * from "./adopt.js";
export * from "./adapters.js";
export * from "./credentials.js";
export * from "./identity.js";
export * from "./intern.js";
export * from "./registry.js";
export {
  type DriverResolveSpec as DriverResolveSpec,
  type ExternalDriverLoader as ExternalDriverLoader,
  type ResolveOptions as ResolveOptions,
  type ResolvePurpose as ResolvePurpose,
} from "./resolve.js";
