import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useFocusEffect } from "@react-navigation/native";

import { recall, remember } from "./host.js";

export type Place =
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "session"; readonly path: string; readonly sessionId: string; readonly fresh: boolean };

type Memory = { readonly path: string; readonly sessionId?: string };

type ShellValue = {
  readonly place: Place;
  setPlace(place: Place): void;
};

const ShellContext = createContext<ShellValue | null>(null);

/** Projects must not wipe a stored place before the first recall has read it. */
let settled = false;

function samePlace(left: Place, right: Place): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "project" && right.kind === "project") return left.path === right.path;
  if (left.kind === "session" && right.kind === "session") {
    return left.path === right.path && left.sessionId === right.sessionId && left.fresh === right.fresh;
  }
  return true;
}

function placeKey(place: Place): string {
  if (place.kind === "session") return `session:${place.path}:${place.sessionId}:${place.fresh}`;
  if (place.kind === "project") return `project:${place.path}`;
  return "projects";
}

function rememberPlace(place: Place): void {
  if (place.kind === "projects") {
    if (settled) remember("");
    return;
  }
  const memory: Memory =
    place.kind === "session" ? { path: place.path, sessionId: place.sessionId } : { path: place.path };
  remember(JSON.stringify(memory));
}

export async function recallPlace(): Promise<Memory | null> {
  try {
    const raw = await recall();
    if (raw === "") return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null || !("path" in parsed) || typeof parsed.path !== "string") {
      return null;
    }
    if (parsed.path === "") return null;
    const sessionId =
      "sessionId" in parsed && typeof parsed.sessionId === "string" && parsed.sessionId !== ""
        ? parsed.sessionId
        : undefined;
    return sessionId == null ? { path: parsed.path } : { path: parsed.path, sessionId };
  } catch {
    return null;
  } finally {
    settled = true;
  }
}

export function ShellProvider({ children }: { readonly children: ReactNode }) {
  const [place, setPlaceState] = useState<Place>({ kind: "projects" });
  const setPlace = useCallback((next: Place) => {
    setPlaceState((current) => (samePlace(current, next) ? current : next));
  }, []);
  const value = useMemo<ShellValue>(() => ({ place, setPlace }), [place, setPlace]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  const shell = useContext(ShellContext);
  if (shell == null) throw new Error("ShellProvider is missing.");
  return shell;
}

/** Remember which screen is up, and keep that place for the next launch. */
export function useScreen(place: Place): void {
  const shell = useShell();
  const held = useRef(place);
  held.current = place;
  const key = placeKey(place);
  useFocusEffect(
    useCallback(() => {
      shell.setPlace(held.current);
      rememberPlace(held.current);
    }, [shell, key]),
  );
}
