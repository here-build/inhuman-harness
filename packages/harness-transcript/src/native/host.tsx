import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import {
  type ColorValue,
  DynamicColorIOS,
  PlatformColor,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewProps,
} from "react-native";

import type { Dial } from "../../../harness-web-app/src/client/dial.js";

/**
 * What the transcript needs from the app that hosts it, injected rather than imported:
 * the Dynamic Type faces, the native context menu, the clipboard and the URL opener.
 * The package stays free of the app's own modules.
 */
export type Role = "body" | "headline" | "callout" | "subhead" | "footnote";

export type Face = {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
};

export type MessageAction = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly destructive?: boolean;
};

export type MessageMenuProps = Pick<ViewProps, "style"> & {
  readonly actions: readonly MessageAction[];
  readonly onAction: (id: string) => void;
  readonly children: ReactNode;
};

export type TranscriptHost = {
  readonly faces: Readonly<Record<Role, Face>>;
  readonly Menu: ComponentType<MessageMenuProps>;
  readonly copy: (text: string) => void;
  readonly openUrl: (url: string) => void;
};

/**
 * The dial rides in context, not props. React's development build walks a component's props to describe
 * what changed; a session document behind a prop makes that walk touch the whole document.
 */
const DialContext = createContext<Dial | null>(null);

export const DialProvider = DialContext.Provider;

export function useDial(): Dial {
  const dial = useContext(DialContext);
  if (dial == null) throw new Error("The transcript needs a dial.");
  return dial;
}

const HostContext = createContext<TranscriptHost | null>(null);

export const HostProvider = HostContext.Provider;

export function useHost(): TranscriptHost {
  const host = useContext(HostContext);
  if (host == null) throw new Error("The transcript needs a host.");
  return host;
}

type Ink =
  | "label"
  | "secondary"
  | "tertiary"
  | "fill"
  | "fillStrong"
  | "separator"
  | "blue"
  | "red"
  | "green"
  | "background"
  | "addFill"
  | "delFill";

export const ink: Readonly<Record<Ink, ColorValue>> = {
  label: PlatformColor("label"),
  secondary: PlatformColor("secondaryLabel"),
  tertiary: PlatformColor("tertiaryLabel"),
  fill: PlatformColor("tertiarySystemFill"),
  fillStrong: PlatformColor("secondarySystemFill"),
  separator: PlatformColor("separator"),
  blue: PlatformColor("systemBlue"),
  red: PlatformColor("systemRed"),
  green: PlatformColor("systemGreen"),
  background: PlatformColor("systemBackground"),
  addFill: DynamicColorIOS({ light: "rgba(52,199,89,0.18)", dark: "rgba(48,209,88,0.26)" }),
  delFill: DynamicColorIOS({ light: "rgba(255,59,48,0.16)", dark: "rgba(255,69,58,0.26)" }),
};

export const MONO = "Menlo";

/** Text in one of the host's Dynamic Type faces. `mono` swaps the family and steps the size down a little. */
export function T({
  role = "body",
  mono = false,
  color = ink.label,
  style,
  children,
  numberOfLines,
  onPress,
  accessibilityRole,
}: {
  readonly role?: Role;
  readonly mono?: boolean;
  readonly color?: TextStyle["color"];
  readonly style?: StyleProp<TextStyle>;
  readonly children?: ReactNode;
  readonly numberOfLines?: number;
  readonly onPress?: () => void;
  readonly accessibilityRole?: "link" | "button";
}) {
  const face = useHost().faces[role];
  return (
    <Text
      allowFontScaling={false}
      numberOfLines={numberOfLines}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      style={[
        { color },
        mono
          ? {
              fontFamily: MONO,
              fontSize: Math.round(face.fontSize * 0.88),
              lineHeight: Math.round(face.lineHeight * 0.95),
            }
          : null,
        mono ? null : { fontSize: face.fontSize, lineHeight: face.lineHeight },
        { fontWeight: face.fontWeight },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
