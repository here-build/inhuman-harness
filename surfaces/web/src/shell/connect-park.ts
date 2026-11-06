/**
 * A parked `connect/adopt` hands back a Scheme body: one call to a `harness/…`
 * callback chunk. The web page renders four of them; anything else is the
 * terminal's to finish. Arrival's `parse` is async, so the step awaits it.
 */
import { parse, type SchemeValue } from "@here.build/arrival";
import { APair, ASymbol } from "@here.build/arrival/reflect-internals";

export type ParkForm =
  /**
   * Open a link. A non-empty `paste` names a field that takes something pasted
   * back instead. `input` is the scheme's remainder kind (`'password`, `'text`).
   */
  | {
      readonly kind: "open-url";
      readonly url: string;
      readonly description: string;
      readonly paste: string;
      readonly input: "password" | "text" | null;
    }
  | { readonly kind: "input"; readonly name: string; readonly description: string; readonly secret: boolean }
  | { readonly kind: "confirm"; readonly name: string; readonly description: string }
  | { readonly kind: "unknown" };

const UNKNOWN: ParkForm = { kind: "unknown" };

export async function parsePark(body: string): Promise<ParkForm> {
  let forms: readonly SchemeValue[];
  try {
    forms = await parse(body);
  } catch {
    return UNKNOWN;
  }
  const form = forms.length === 1 ? forms[0] : undefined;
  if (!(form instanceof APair) || !(form.car instanceof ASymbol)) return UNKNOWN;
  const args = keywords(form.cdr);
  const text = (key: string, fallback = ""): string => {
    const value = args.get(key);
    return typeof value === "string" ? value : fallback;
  };
  switch (form.car.valueOf()) {
    case "harness/open-url": {
      const url = text("url");
      // The link is rendered as an anchor: only web links, whatever the body says.
      if (!/^https?:\/\//i.test(url)) return UNKNOWN;
      const input = inputKind(args.get("input"));
      const paste = args.has("input") ? text("name", "Or paste it here") : "";
      return { kind: "open-url", url, description: text("description"), paste, input };
    }
    case "harness/input":
      return {
        kind: "input",
        name: text("name", "Input"),
        description: text("description"),
        secret: args.get("secret") === true,
      };
    case "harness/confirm":
      return { kind: "confirm", name: text("name") || text("title", "Confirm"), description: text("description") };
    default:
      return UNKNOWN;
  }
}

/**
 * A redirect address is typed in the clear. A `'password` remainder is a real
 * secret (a key or a token) and stays masked; `'text` does not.
 */
export function openUrlFieldType(paste: string, input: "password" | "text" | null): "url" | "password" | "text" {
  if (paste !== "" && isRedirectAddress(paste)) return "url";
  if (input === "password") return "password";
  return "text";
}

function isRedirectAddress(paste: string): boolean {
  return /\b(?:address|url)\b/i.test(paste) && !/\b(?:key|token|secret|password)\b/i.test(paste);
}

function inputKind(value: string | boolean | null | undefined): "password" | "text" | null {
  return value === "password" || value === "text" ? value : null;
}

/** `:key value` pairs after the head; a string is its text, a symbol or `'symbol` is its name, `#t` is true. */
function keywords(rest: unknown): Map<string, string | boolean | null> {
  const found = new Map<string, string | boolean | null>();
  let cursor = rest;
  while (cursor instanceof APair) {
    const key = cursor.car;
    const next = cursor.cdr;
    if (key instanceof ASymbol && String(key).startsWith(":") && next instanceof APair) {
      found.set(String(key).slice(1), keywordPlain(next.car));
      cursor = next.cdr;
    } else {
      cursor = next;
    }
  }
  return found;
}

/** `'password` arrives as `(quote password)`, not a bare symbol. */
function keywordPlain(value: unknown): string | boolean | null {
  const quoted = quotedSymbol(value);
  if (quoted != null) return quoted;
  if (value instanceof ASymbol) {
    const name = value.valueOf();
    return typeof name === "string" ? name : null;
  }
  const plain = (value as { valueOf(): unknown }).valueOf();
  return typeof plain === "string" || typeof plain === "boolean" ? plain : null;
}

function quotedSymbol(value: unknown): string | null {
  if (!(value instanceof APair) || !(value.car instanceof ASymbol) || value.car.valueOf() !== "quote") return null;
  if (!(value.cdr instanceof APair) || !(value.cdr.car instanceof ASymbol)) return null;
  const name = value.cdr.car.valueOf();
  return typeof name === "string" ? name : null;
}
