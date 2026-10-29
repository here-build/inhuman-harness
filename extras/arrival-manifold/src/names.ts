// names — the ONE source of truth for the manifold tool's public identity. The tool name
// and its argument name are the two highest-salience tokens a model reads on every call,
// so they are chosen to TEACH: the name says what the surface is (a Scheme REPL wrapping
// every connected MCP tool), the argument says what goes in it (a program — not "an
// expression", which quietly argues against composition). Every consumer (describe(),
// catalog preamble, every door's prose, the module gate) imports from here — a rename is
// a one-line change.

/** The MCP tool name. */
export const TOOL_NAME = "scheme-repl-with-all-mcp-tools";

/** The single required argument: a Scheme program (one string, or an array of statement
 *  strings executed together as one program). */
export const ARG_NAME = "repl-input-scheme-program";

/** Per-call response character budget for THIS call (clamped by manifold-tool.ts and
 *  applied to that call's serializer only; never mutates the world default). */
export const RESPONSE_SIZE_ARG_NAME = "response-size";

/** Per-call binary-attachment pass-through quota (clamped to [0, MAX_PASSTHROUGH_ATTACHMENTS],
 *  manifold-tool.ts); absent ⇒ DEFAULT_PASSTHROUGH_ATTACHMENTS. Same per-call-only,
 *  never-mutates-the-world-default shape as `RESPONSE_SIZE_ARG_NAME`. */
export const RESPONSE_ATTACHMENTS_ARG_NAME = "response-attachments";

/** Per-call evaluation time budget (ms) for THIS call — clamped by manifold-tool.ts and
 *  passed to the runner's per-call timeout; absent ⇒ DEFAULT_EVAL_TIMEOUT_MS. Same per-call-only,
 *  never-mutates-the-world-default shape as `RESPONSE_SIZE_ARG_NAME`. Lets a call give a known-slow
 *  upstream tool more room (the amplifier fix for slow-tool → hard-timeout on the REPL seam). */
export const EVAL_TIMEOUT_ARG_NAME = "eval-timeout-ms";
