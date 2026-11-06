import type { ColorScheme, HighlightLine } from "./highlight.js";

export type EmbedRegion = {
  readonly start: number;
  readonly end: number;
  readonly lang: string;
};

export type DiffTokenRun = {
  readonly text: string;
  readonly color?: string;
};

export type DiffHighlightResult = {
  readonly oldLines: readonly (readonly DiffTokenRun[])[];
  readonly newLines: readonly (readonly DiffTokenRun[])[];
};

type SyntaxWasmExports = {
  readonly memory: WebAssembly.Memory;
  qd_alloc(len: number): number;
  qd_dealloc(ptr: number, len: number): void;
  qd_result_ptr(): number;
  qd_result_len(): number;
  qd_highlight_lines(
    codePtr: number,
    codeLen: number,
    langPtr: number,
    langLen: number,
    schemePtr: number,
    schemeLen: number,
  ): number;
  qd_highlight_diff(
    oldPtr: number,
    oldLen: number,
    newPtr: number,
    newLen: number,
    pathPtr: number,
    pathLen: number,
  ): number;
  qd_guess_lang(codePtr: number, codeLen: number): number;
  qd_detect_embeds(cmdPtr: number, cmdLen: number): number;
};

const CACHE_NAME = "inhuman-syntax-wasm-v1";
const wasmUrl = new URL("syntax.wasm", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let liveExports: SyntaxWasmExports | null = null;
let loadingPromise: Promise<SyntaxWasmExports | null> | null = null;

function isSyntaxWasmExports(exports: WebAssembly.Exports): exports is SyntaxWasmExports {
  return (
    exports.memory instanceof WebAssembly.Memory &&
    typeof exports.qd_alloc === "function" &&
    typeof exports.qd_dealloc === "function" &&
    typeof exports.qd_result_ptr === "function" &&
    typeof exports.qd_result_len === "function" &&
    typeof exports.qd_highlight_lines === "function" &&
    typeof exports.qd_highlight_diff === "function" &&
    typeof exports.qd_guess_lang === "function" &&
    typeof exports.qd_detect_embeds === "function"
  );
}

function syncExports(): SyntaxWasmExports | null {
  if (liveExports !== null) return liveExports;
  if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
    try {
      const fs = process.getBuiltinModule("node:fs");
      const nodeUrl = new URL(["syntax", "wasm"].join("."), import.meta.url);
      const bytes = fs.readFileSync(nodeUrl);
      const mod = new WebAssembly.Module(bytes);
      const instance = new WebAssembly.Instance(mod, {});
      if (isSyntaxWasmExports(instance.exports)) {
        liveExports = instance.exports;
        return liveExports;
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchCachedWasm(url: URL): Promise<Response> {
  const href = url.href;
  const storage = typeof globalThis.caches === "object" ? globalThis.caches : undefined;
  if (storage !== undefined) {
    try {
      const cache = await storage.open(CACHE_NAME);
      const hit = await cache.match(href);
      if (hit !== undefined) return hit;
      const response = await fetch(href);
      if (response.ok) {
        await cache.put(href, response.clone());
      }
      return response;
    } catch {
      // Fall through to direct fetch when Cache Storage is unavailable (e.g. opaque origins).
    }
  }
  return fetch(href);
}

async function instantiateBrowserWasm(url: URL): Promise<SyntaxWasmExports | null> {
  try {
    const response = await fetchCachedWasm(url);
    if (!response.ok) return null;
    let instance: WebAssembly.Instance;
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        const streamed = await WebAssembly.instantiateStreaming(response.clone(), {});
        instance = streamed.instance;
      } catch {
        const bytes = await response.arrayBuffer();
        const instantiated = await WebAssembly.instantiate(bytes, {});
        instance = instantiated.instance;
      }
    } else {
      const bytes = await response.arrayBuffer();
      const instantiated = await WebAssembly.instantiate(bytes, {});
      instance = instantiated.instance;
    }
    if (!isSyntaxWasmExports(instance.exports)) return null;
    liveExports = instance.exports;
    return liveExports;
  } catch {
    return null;
  }
}

export function ensureSyntaxWasm(): Promise<SyntaxWasmExports | null> {
  const loaded = syncExports();
  if (loaded !== null) return Promise.resolve(loaded);
  loadingPromise ??= instantiateBrowserWasm(wasmUrl).catch(() => {
    loadingPromise = null;
    return null;
  });
  return loadingPromise;
}

if (
  typeof window !== "undefined" &&
  (typeof process === "undefined" || typeof process.getBuiltinModule !== "function")
) {
  void ensureSyntaxWasm();
}

function writeUtf8(wasm: SyntaxWasmExports, text: string): readonly [number, number] {
  if (text.length === 0) return [0, 0];
  const bytes = encoder.encode(text);
  if (bytes.length === 0) return [0, 0];
  const ptr = wasm.qd_alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}

function freeUtf8(wasm: SyntaxWasmExports, [ptr, len]: readonly [number, number]): void {
  if (len > 0) wasm.qd_dealloc(ptr, len);
}

function readResultUtf8(wasm: SyntaxWasmExports): string {
  const len = wasm.qd_result_len();
  if (len === 0) return "";
  const ptr = wasm.qd_result_ptr();
  return decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}

export function wasmGuessLang(code: string): string | undefined {
  if (code.length === 0) return undefined;
  const wasm = syncExports();
  if (wasm === null) return undefined;
  const span = writeUtf8(wasm, code);
  try {
    wasm.qd_guess_lang(span[0], span[1]);
    const out = readResultUtf8(wasm);
    return out === "" ? undefined : out;
  } finally {
    freeUtf8(wasm, span);
  }
}

export function wasmDetectShellEmbeds(command: string): EmbedRegion[] {
  if (command.length === 0) return [];
  const wasm = syncExports();
  if (wasm === null) return [];
  const span = writeUtf8(wasm, command);
  try {
    wasm.qd_detect_embeds(span[0], span[1]);
    const json = readResultUtf8(wasm);
    if (json === "") return [];
    return JSON.parse(json) as EmbedRegion[];
  } catch {
    return [];
  } finally {
    freeUtf8(wasm, span);
  }
}

export async function wasmHighlightLines(
  code: string,
  lang: string,
  scheme: ColorScheme,
  guess = false,
): Promise<HighlightLine[] | null> {
  if (code.length === 0) return null;
  const wasm = await ensureSyntaxWasm();
  if (wasm === null) return null;
  let targetLang = lang;
  if (guess && (targetLang === "" || targetLang === "text")) {
    targetLang = wasmGuessLang(code) ?? "text";
  }
  if (targetLang === "" || targetLang === "text") return null;
  const codeSpan = writeUtf8(wasm, code);
  const langSpan = writeUtf8(wasm, targetLang);
  const schemeSpan = writeUtf8(wasm, scheme);
  try {
    wasm.qd_highlight_lines(codeSpan[0], codeSpan[1], langSpan[0], langSpan[1], schemeSpan[0], schemeSpan[1]);
    const json = readResultUtf8(wasm);
    if (json === "" || json === "null") return null;
    return JSON.parse(json) as HighlightLine[];
  } catch {
    return null;
  } finally {
    freeUtf8(wasm, codeSpan);
    freeUtf8(wasm, langSpan);
    freeUtf8(wasm, schemeSpan);
  }
}

export async function wasmHighlightDiff(
  oldText: string,
  newText: string,
  path: string,
): Promise<DiffHighlightResult | null> {
  if (path === "" || (oldText.length === 0 && newText.length === 0)) return null;
  const wasm = await ensureSyntaxWasm();
  if (wasm === null) return null;
  const oldSpan = writeUtf8(wasm, oldText);
  const newSpan = writeUtf8(wasm, newText);
  const pathSpan = writeUtf8(wasm, path);
  try {
    wasm.qd_highlight_diff(oldSpan[0], oldSpan[1], newSpan[0], newSpan[1], pathSpan[0], pathSpan[1]);
    const json = readResultUtf8(wasm);
    if (json === "" || json === "null") return null;
    return JSON.parse(json) as DiffHighlightResult;
  } catch {
    return null;
  } finally {
    freeUtf8(wasm, oldSpan);
    freeUtf8(wasm, newSpan);
    freeUtf8(wasm, pathSpan);
  }
}
