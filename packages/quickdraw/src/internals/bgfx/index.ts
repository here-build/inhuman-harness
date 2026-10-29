/**
 * Procedural cell backgrounds = GLSL color-field shaders.
 *
 * Optional present-path canary (headroom under wash), not product chrome.
 * TEA/layout writes style.bgFx = program id (+ baked UV).
 * Present materialize* → bgRgb only.
 *
 * Catalog: registerShadertoyCatalog / loadShadertoyFile / activateShadertoy.
 */

export * from "./types.js";
export * from "./registry.js";
export * from "./materialize.js";
export * from "./shadertoy-gl.js";
export * from "./shadertoy-catalog.js";
export * from "./shader-frame-host.js";
export * from "./opacity.js";
