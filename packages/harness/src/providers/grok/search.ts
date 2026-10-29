import type { WebSearchHit } from "@inhuman.tools/harness-model";

function readField(obj: object, key: string): unknown {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return value;
}

export function grokHitsFromResponses(payload: unknown, limit: number): WebSearchHit[] {
  if (payload === null || typeof payload !== "object") return [];
  const citations = readField(payload, "citations");
  const output = readField(payload, "output");
  const out: WebSearchHit[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string, snippet: string): void => {
    const href = url.trim();
    if (href === "" || seen.has(href) || out.length >= limit) return;
    seen.add(href);
    out.push({
      title: title.trim() || grokHostnameOf(href),
      url: href,
      snippet,
    });
  };
  if (Array.isArray(citations)) {
    for (const item of citations) {
      if (typeof item === "string") add(item, "", "");
      else if (item !== null && typeof item === "object") {
        const url = readField(item, "url");
        if (typeof url === "string") {
          const title = readField(item, "title");
          const snippet = readField(item, "snippet");
          add(url, typeof title === "string" ? title : "", typeof snippet === "string" ? snippet : "");
        }
      }
    }
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item === null || typeof item !== "object") continue;
      const content = readField(item, "content");
      if (readField(item, "type") === "message" && Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== "object") continue;
          const annotations = readField(block, "annotations");
          if (!Array.isArray(annotations)) continue;
          for (const annotation of annotations) {
            if (annotation === null || typeof annotation !== "object") continue;
            const url = readField(annotation, "url");
            const title = readField(annotation, "title");
            if (typeof url === "string") add(url, typeof title === "string" ? title : "", "");
          }
        }
      }
    }
  }
  return out;
}

function grokHostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
