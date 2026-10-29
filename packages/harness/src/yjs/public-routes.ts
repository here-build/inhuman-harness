/**
 * Public document-route contract. Opening an existing identity is not
 * creation; composition decides how to serve each action.
 */
import { documentKey, KERNEL_DOCUMENT_KEY, type DocumentKey, type PublicRoomName } from "@/protocol/document";

export const UPGRADE_NOT_FOUND = 404;
export const UPGRADE_ROUTE_FAILED = 500;

export type PublicUpgrade =
  | { readonly action: "open"; readonly key: DocumentKey }
  | {
      readonly action: "create";
      readonly room: PublicRoomName;
      readonly path?: string;
      readonly sessionId?: string;
    }
  | {
      readonly action: "refuse";
      readonly status: number;
      readonly reason: string;
    };

export function classifyPublicUpgrade(url: string): PublicUpgrade {
  const [pathname = "/", search = ""] = url.split("?");
  const query = new URLSearchParams(search);
  const path = query.get("path");
  const sessionId = query.get("sessionId");
  switch (pathname) {
    case "/kernel":
      return { action: "open", key: KERNEL_DOCUMENT_KEY };
    case "/project": {
      if (path == null || path === "") {
        return { action: "refuse", status: 400, reason: "missing path" };
      }
      return { action: "open", key: documentKey("projects", path) };
    }
    case "/session": {
      if (path == null || path === "") {
        if (sessionId != null && sessionId !== "") {
          return { action: "open", key: documentKey("sessions", sessionId) };
        }
        return { action: "refuse", status: 400, reason: "missing path" };
      }
      if (sessionId != null && sessionId !== "") {
        return { action: "create", room: "session", path, sessionId };
      }
      return { action: "create", room: "session", path };
    }
    default:
      return {
        action: "refuse",
        status: UPGRADE_NOT_FOUND,
        reason: "not found",
      };
  }
}
