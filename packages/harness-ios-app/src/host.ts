import { NativeEventEmitter, NativeModules } from "react-native";

type Host = {
  impact: () => void;
  setArmed: (armed: boolean) => void;
  textStyles?: () => Promise<unknown>;
  remember?: (json: string) => void;
  recall?: () => Promise<string>;
};

function host(): Host | null {
  const native: unknown = NativeModules.HarnessHost;
  if (typeof native !== "object" || native == null) return null;
  if (!("impact" in native) || typeof native.impact !== "function") return null;
  if (!("setArmed" in native) || typeof native.setArmed !== "function") return null;
  return native as Host;
}

export function impact(): void {
  host()?.impact();
}

/** Command-Return allows. Command-Delete denies. The native side swallows the chord only while armed. */
export function listenForCommands(onCommand: (name: "allow" | "deny") => void): () => void {
  const native = host();
  if (native == null) return () => undefined;
  native.setArmed(true);
  const subscription = new NativeEventEmitter(NativeModules.HarnessHost).addListener(
    "keyCommand",
    (event: { name?: string }) => {
      if (event.name === "allow" || event.name === "deny") onCommand(event.name);
    },
  );
  return () => {
    subscription.remove();
    native.setArmed(false);
  };
}

export async function loadFaces(): Promise<unknown> {
  const native = host();
  if (native?.textStyles == null) return null;
  try {
    return await native.textStyles();
  } catch {
    return null;
  }
}

/** The installed binary only emits `keyCommand` until it is rebuilt with text metrics. */
export function listenForContentSize(onChange: (value: unknown) => void): () => void {
  const native = host();
  if (native?.textStyles == null) return () => undefined;
  const subscription = new NativeEventEmitter(NativeModules.HarnessHost).addListener("contentSize", onChange);
  return () => subscription.remove();
}

/** Empty clears the last place. A native rebuild is required before this reaches UserDefaults. */
export function remember(json: string): void {
  host()?.remember?.(json);
}

export async function recall(): Promise<string> {
  const native = host();
  if (native?.recall == null) return "";
  try {
    return await native.recall();
  } catch {
    return "";
  }
}

type Docs = {
  read: (key: string) => Promise<string | null>;
  append: (key: string, base64: string) => Promise<boolean>;
  replace: (key: string, base64: string) => Promise<boolean>;
  drop: (key: string) => Promise<boolean>;
};

/** The document cache's file store (Library/Caches/inhuman-docs). Null until the installed binary has it. */
export function docs(): Docs | null {
  const native: unknown = NativeModules.HarnessDocs;
  if (typeof native !== "object" || native == null) return null;
  if (!("read" in native) || typeof native.read !== "function") return null;
  return native as Docs;
}
