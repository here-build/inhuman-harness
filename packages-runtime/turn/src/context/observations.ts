/**
 * Model-facing copy for completion input. Vendor HTTP errors are not here.
 */
import { prompt } from "@inhuman.tools/harness-commons";

/** No-tools face: unhomed completion, empty catalog, or Approvable parent (judge). */
export const NO_TOOLS_SYSTEM = prompt.system`Reply in prose. You do not have tools.`;

/** Unresolved foreground tool row. */
export const IN_FLIGHT_TOOL = "in-flight";

/** Unresolved background tool row. */
export const BACKGROUND_TOOL = "running in background";
