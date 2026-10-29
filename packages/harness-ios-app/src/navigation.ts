import { createNavigationContainerRef, type NavigatorScreenParams } from "@react-navigation/native";

export type MainStackParamList = {
  Projects: undefined;
  Sessions: { readonly path: string; readonly name: string };
  Session: { readonly path: string; readonly sessionId: string; readonly fresh?: boolean };
};

export type SettingsParams = { readonly kind: "workspace" } | { readonly kind: "project"; readonly path: string };

export type RootParamList = {
  Main: NavigatorScreenParams<MainStackParamList>;
  Attention: { readonly path: string | null };
  Settings: SettingsParams;
  Model: undefined;
};

export const navigationRef = createNavigationContainerRef<RootParamList>();

export function openAttention(path: string | null): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate("Attention", { path });
}

export function openSettings(target: SettingsParams): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate("Settings", target);
}

export function openModel(): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate("Model");
}

/** Pop a page sheet and show the session on the stack underneath. */
export function showSession(path: string, sessionId: string): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate("Main", { screen: "Session", params: { path, sessionId } });
}

let linked = false;

/** True once a deep link has placed the user; launch place-restore must not override it. */
export function wasLinked(): boolean {
  return linked;
}

/** Hermes ships URLSearchParams without `get`, so the query is split by hand. */
function readQuery(raw: string | undefined): Map<string, string> {
  const query = new Map<string, string>();
  for (const pair of (raw ?? "").split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = decodeURIComponent(at === -1 ? pair : pair.slice(0, at));
    const value = at === -1 ? "" : decodeURIComponent(pair.slice(at + 1).replaceAll("+", " "));
    query.set(key, value);
  }
  return query;
}

function nameOf(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/**
 * `inhuman://projects`, `inhuman://project?path=…`, `inhuman://session?path=…&id=…`,
 * `inhuman://attention`, `inhuman://settings[?path=…]`, `inhuman://model`.
 * Any of them takes `sheet=attention|settings|model` to open a sheet over the screen.
 */
export function openLink(url: string): boolean {
  if (!navigationRef.isReady()) return false;
  if (!url.startsWith("inhuman://")) return false;
  const rest = url.slice("inhuman://".length).split("#")[0] ?? "";
  const mark = rest.indexOf("?");
  const host = (mark === -1 ? rest : rest.slice(0, mark)).replace(/\/+$/, "");
  const query = readQuery(mark === -1 ? "" : rest.slice(mark + 1));
  const path = query.get("path") ?? "";
  const sessionId = query.get("id") ?? "";
  const routes: { name: keyof MainStackParamList; params?: object }[] = [{ name: "Projects" }];
  if ((host === "project" || host === "session") && path !== "") {
    routes.push({ name: "Sessions", params: { path, name: nameOf(path) } });
  }
  if (host === "session" && sessionId !== "") routes.push({ name: "Session", params: { path, sessionId } });
  linked = true;
  navigationRef.reset({
    index: 0,
    routes: [{ name: "Main", state: { index: routes.length - 1, routes } }],
  });
  const sheet = query.get("sheet") ?? (["attention", "settings", "model"].includes(host) ? host : "");
  switch (sheet) {
    case "attention":
      openAttention(null);
      break;
    case "settings":
      openSettings(path === "" ? { kind: "workspace" } : { kind: "project", path });
      break;
    case "model":
      openModel();
      break;
    default:
      break;
  }
  return true;
}
