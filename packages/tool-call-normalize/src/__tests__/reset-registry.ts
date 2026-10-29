import { dialectRegistry } from "../dialects/registry.js";

/** Isolate the dialect registry between tests. Not a production export. */
export function resetRegistryForTests(): void {
  dialectRegistry.clear();
}
