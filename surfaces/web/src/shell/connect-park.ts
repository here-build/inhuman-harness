/**
 * A parked `connect/adopt` hands back a JSON UI definition (`UiDefinition`).
 * The web page renders three of them (`open-url`, `input`, `confirm`);
 * anything else is the terminal's to finish.
 */
import { parseUiDefinition } from "@inhuman.tools/harness-contract";

export type ParkForm =
  /**
   * Open a link. A non-empty `paste` names a field that takes something pasted
   * back instead. `input` is the remainder kind (`"password"`, `"text"`).
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
  const def = parseUiDefinition(body);
  if (def === null) return UNKNOWN;
  switch (def.kind) {
    case "open-url": {
      // The link is rendered as an anchor: only web links, whatever the body says.
      if (!/^https?:\/\//i.test(def.url)) return UNKNOWN;
      const input = def.input ?? null;
      const paste = def.input !== undefined ? (def.name ?? "Or paste it here") : "";
      return { kind: "open-url", url: def.url, description: def.description ?? "", paste, input };
    }
    case "input":
      return {
        kind: "input",
        name: def.name ?? "Input",
        description: def.description ?? "",
        secret: def.secret === true,
      };
    case "confirm":
      return {
        kind: "confirm",
        name: def.name || def.title || "Confirm",
        description: def.description ?? "",
      };
    default:
      return UNKNOWN;
  }
}

/**
 * A redirect address is typed in the clear. A `"password"` remainder is a real
 * secret (a key or a token) and stays masked; `"text"` does not.
 */
export function openUrlFieldType(paste: string, input: "password" | "text" | null): "url" | "password" | "text" {
  if (paste !== "" && isRedirectAddress(paste)) return "url";
  if (input === "password") return "password";
  return "text";
}

function isRedirectAddress(paste: string): boolean {
  return /\b(?:address|url)\b/i.test(paste) && !/\b(?:key|token|secret|password)\b/i.test(paste);
}
