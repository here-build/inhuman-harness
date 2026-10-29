import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PlatformColor, Text, type ColorValue, type StyleProp, type TextStyle } from "react-native";

import { listenForContentSize, loadFaces } from "./host.js";

export type Role = "body" | "headline" | "callout" | "subhead" | "footnote";

export type Face = {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
};

type Faces = Record<Role, Face>;

const FALLBACK: Faces = {
  body: { fontSize: 17, lineHeight: 22, fontWeight: "400" },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: "400" },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: "400" },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
};

const labelColor = PlatformColor("label");
const secondaryColor = PlatformColor("secondaryLabel");

const TypeContext = createContext<Faces | null>(null);

function faceFrom(value: unknown): Face | null {
  if (typeof value !== "object" || value == null) return null;
  if (!("fontSize" in value) || !("lineHeight" in value) || !("fontWeight" in value)) return null;
  const { fontSize, lineHeight, fontWeight } = value;
  if (typeof fontSize !== "number" || typeof lineHeight !== "number" || fontSize <= 0 || lineHeight <= 0) return null;
  if (fontWeight !== "400" && fontWeight !== "500" && fontWeight !== "600" && fontWeight !== "700") return null;
  return { fontSize, lineHeight, fontWeight };
}

function facesFrom(value: unknown): Faces | null {
  if (typeof value !== "object" || value == null) return null;
  const body = faceFrom("body" in value ? value.body : null);
  const headline = faceFrom("headline" in value ? value.headline : null);
  const callout = faceFrom("callout" in value ? value.callout : null);
  const subhead = faceFrom("subhead" in value ? value.subhead : null);
  const footnote = faceFrom("footnote" in value ? value.footnote : null);
  if (body == null || headline == null || callout == null || subhead == null || footnote == null) return null;
  return { body, headline, callout, subhead, footnote };
}

export function TypeProvider({ children }: { readonly children: ReactNode }) {
  const [faces, setFaces] = useState(FALLBACK);
  useEffect(() => {
    let live = true;
    void loadFaces().then((value) => {
      const next = facesFrom(value);
      if (live && next != null) setFaces(next);
      return undefined;
    });
    const stop = listenForContentSize((value) => {
      const next = facesFrom(value);
      if (live && next != null) setFaces(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return <TypeContext.Provider value={faces}>{children}</TypeContext.Provider>;
}

export function useType(): Faces {
  const faces = useContext(TypeContext);
  if (faces == null) throw new Error("TypeProvider is missing.");
  return faces;
}

export function Label({
  role = "body",
  color,
  style,
  children,
  numberOfLines,
  ellipsizeMode,
  accessibilityLiveRegion,
}: {
  readonly role?: Role;
  readonly color?: ColorValue;
  readonly style?: StyleProp<TextStyle>;
  readonly children: ReactNode;
  readonly numberOfLines?: number;
  readonly ellipsizeMode?: "head" | "middle" | "tail" | "clip";
  readonly accessibilityLiveRegion?: "none" | "polite" | "assertive";
}) {
  const face = useType()[role];
  const ink = role === "subhead" || role === "footnote" ? secondaryColor : labelColor;
  return (
    <Text
      allowFontScaling={false}
      accessibilityLiveRegion={accessibilityLiveRegion}
      ellipsizeMode={ellipsizeMode}
      numberOfLines={numberOfLines}
      style={[
        { color: ink },
        style,
        { fontSize: face.fontSize, lineHeight: face.lineHeight, fontWeight: face.fontWeight },
        color != null ? { color } : null,
      ]}
    >
      {children}
    </Text>
  );
}
