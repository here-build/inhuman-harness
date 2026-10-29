import Mustache from "mustache";

import { validateOpts } from "./schema.js";
import type { CatalogTool } from "./types.js";

Mustache.escape = (text) => text;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonText(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  const start = trimmed[0];
  if (start !== "{" && start !== "[" && start !== '"') return raw;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

const MCP_CONTENT_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);
const IMAGE_HREF = /\.(png|jpe?g|gif|webp|svg)(\?[^)]*)?$/i;

function isMcpContentBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.type === "string" && MCP_CONTENT_TYPES.has(value.type);
}

function isImageHref(href: string): boolean {
  const trimmed = href.trim();
  return trimmed.startsWith("data:image/") || IMAGE_HREF.test(trimmed);
}

function imageHrefsFromMarkdown(text: string): string[] {
  const out: string[] = [];
  const re = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of text.matchAll(re)) {
    const href = match[1]?.trim();
    if (href !== undefined && isImageHref(href)) out.push(href);
  }
  return out;
}

function dataUrlFromImageBlock(block: Record<string, unknown>): string | undefined {
  if (typeof block.data !== "string" || block.data === "") return undefined;
  const mime = typeof block.mimeType === "string" && block.mimeType !== "" ? block.mimeType : "image/png";
  return `data:${mime};base64,${block.data}`;
}

function dataUrlFromString(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:image/")) return trimmed;
  if (trimmed.length > 80 && trimmed.startsWith("iVBOR")) return `data:image/png;base64,${trimmed}`;
  if (trimmed.length > 80 && trimmed.startsWith("/9j/")) return `data:image/jpeg;base64,${trimmed}`;
  return undefined;
}

function stripImageHrefs(text: string, hrefs: readonly string[]): string {
  let next = text;
  for (const href of hrefs) {
    const escaped = href.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    next = next.replaceAll(new RegExp(String.raw`!?\[[^\]]*\]\(${escaped}\)`, "g"), "");
  }
  return next.replaceAll(/^[ \t]*[-*][ \t]*$/gm, "").trim();
}

function textPayload(lifted: unknown): string | undefined {
  if (typeof lifted === "string") return lifted;
  if (lifted === undefined) return undefined;
  return JSON.stringify(lifted, null, 2);
}

function mediaValue(
  images: readonly { src: string }[],
  texts: readonly string[],
): { images: { src: string }[]; texts: string[] } {
  return { images: [...images], texts: [...texts] };
}

/**
 * MCP success is often a JSON string or a `content[]`. Lift JSON so named-field
 * templates see objects. Image / mixed `content` becomes `{ images: [{ src }],
 * texts }` so a card can emit `![]({{src}})`. `src` is a file or URL when sibling
 * text names one; otherwise a data URL. `data` stays off the line when a path
 * exists. Markdown / YAML stays a string.
 */
export function liftResultView(result: unknown): Record<string, unknown> {
  const snap: Record<string, unknown> = isRecord(result) ? { ...result } : {};
  snap.value = liftMcpValue(snap.value);
  return snap;
}

function liftMcpValue(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 0 && value.every(isMcpContentBlock)) {
    return liftContentArray(value);
  }
  if (typeof value === "string") {
    const asImage = dataUrlFromString(value);
    if (asImage !== undefined) return mediaValue([{ src: asImage }], []);
    const parsed = parseJsonText(value);
    if (parsed !== value) return parsed;
    const hrefs = imageHrefsFromMarkdown(value);
    if (hrefs.length > 0) {
      const rest = stripImageHrefs(value, hrefs);
      return mediaValue(
        hrefs.map((src) => ({ src })),
        rest === "" ? [] : [rest],
      );
    }
    return value;
  }
  return value;
}

function srcFromImageBlock(block: Record<string, unknown>): string | undefined {
  if (typeof block.url === "string" && block.url !== "") return block.url;
  if (typeof block.uri === "string" && block.uri !== "") return block.uri;
  return dataUrlFromImageBlock(block);
}

function liftTextOnly(rawTexts: readonly string[]): unknown {
  if (rawTexts.length === 1) {
    const asImage = dataUrlFromString(rawTexts[0] ?? "");
    if (asImage !== undefined) return mediaValue([{ src: asImage }], []);
  }
  const lifted = rawTexts.map(parseJsonText);
  return lifted.length === 1 ? lifted[0] : lifted;
}

function liftContentArray(blocks: readonly Record<string, unknown>[]): unknown {
  const imageBlocks = blocks.filter((block) => block.type === "image");
  const textBlocks = blocks.filter((block) => block.type === "text");
  const rawTexts = textBlocks.map((block) => String(block.text ?? ""));
  const hrefs = rawTexts.flatMap(imageHrefsFromMarkdown);
  if (imageBlocks.length === 0) return liftTextOnly(rawTexts);
  const unused = [...hrefs];
  const images: { src: string }[] = [];
  for (const block of imageBlocks) {
    const fromText = unused.shift();
    const src = fromText ?? srcFromImageBlock(block);
    if (src !== undefined) images.push({ src });
  }
  for (const src of unused) images.push({ src });
  if (images.length === 0) return liftTextOnly(rawTexts);
  const texts = rawTexts
    .map((raw) => stripImageHrefs(raw, hrefs))
    .map((raw) => textPayload(parseJsonText(raw)))
    .filter((text): text is string => text !== undefined && text !== "");
  return mediaValue(images, texts);
}

export type RenderKind = "question" | "effect" | "result";

export type RenderOk = { readonly ok: true; readonly markdown: string };
export type RenderFail = { readonly ok: false; readonly error: string };
export type RenderResult = RenderOk | RenderFail;

export type IdentityView = {
  readonly line: string;
  readonly block: string;
};

/** Compact vs expanded: first line names the call; the rest is the extra block. */
export function splitIdentity(markdown: string): IdentityView {
  const nl = markdown.indexOf("\n");
  if (nl === -1) return { line: markdown, block: "" };
  return {
    line: markdown.slice(0, nl),
    block: markdown
      .slice(nl + 1)
      .replace(/^\n+/, "")
      .replace(/\n+$/, ""),
  };
}

export function renderMustache(template: string, view: unknown): string {
  return Mustache.render(template, view ?? {});
}

export function renderTool(
  tool: CatalogTool,
  kind: RenderKind,
  args: Record<string, unknown>,
  result?: unknown,
  options?: { readonly validate?: boolean },
): RenderResult {
  if (kind !== "result") {
    if (options?.validate !== false) {
      const errors = validateOpts(tool.opts, args);
      if (errors.length > 0) return { ok: false, error: errors.join("; ") };
    }
    const template = kind === "question" ? tool.question : tool.effect;
    if (template === null || template.trim() === "") return { ok: false, error: `uncovered ${kind}` };
    return { ok: true, markdown: renderMustache(template, args) };
  }
  const template = tool.result.serializer;
  if (template === null || template.trim() === "") return { ok: false, error: "uncovered result serializer" };
  return { ok: true, markdown: renderMustache(template, liftResultView(result)) };
}
