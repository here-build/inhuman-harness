/**
 * ./index.js — terminal feature detection.
 *
 * Pure parse + env heuristics + optional I/O probes.
 * No theme math (ground OKLCH lives in ../theme/index.js).
 * No TTY lifecycle (alt-screen lives in ../runtime/index.js).
 */

export * from "./types.js";
export * from "./sequences.js";
export * from "./parse.js";
export * from "./env.js";
export * from "./probe.js";
