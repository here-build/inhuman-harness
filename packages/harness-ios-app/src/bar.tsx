import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { Appearance } from "react-native";

import { orange, red } from "./chrome.js";

// The stack header runs the badge fill through the `color` package to pick black or white text.
// That parser rejects PlatformColor (`{"semantic":["systemRed"]}`), so the tones are the fixed hex
// values of systemOrange and systemRed in both appearances. Read at construction time; a
// mid-session appearance flip catches up the next time the header items are rebuilt.
const BADGE = {
  light: { orange: "#FF9500", red: "#FF3B30" },
  dark: { orange: "#FF9F0A", red: "#FF453A" },
} as const;

export function attentionItem(
  tone: "yellow" | "red" | "clear",
  count: number,
  onPress: () => void,
): NativeStackHeaderItem {
  const tint = tone === "yellow" ? orange : tone === "red" ? red : undefined;
  const palette = Appearance.getColorScheme() === "dark" ? BADGE.dark : BADGE.light;
  const badgeColor = tone === "yellow" ? palette.orange : tone === "red" ? palette.red : undefined;
  return {
    type: "button",
    label: "",
    icon: { type: "sfSymbol", name: "bell" },
    ...(tint == null ? {} : { tintColor: tint }),
    ...(count > 0 && badgeColor != null
      ? { badge: { value: count, style: { backgroundColor: badgeColor, color: "white" } } }
      : {}),
    accessibilityLabel: count === 0 ? "Attention" : `${count} need attention`,
    onPress,
  };
}

export function settingsItem(onPress: () => void): NativeStackHeaderItem {
  return {
    type: "button",
    label: "",
    icon: { type: "sfSymbol", name: "gearshape" },
    accessibilityLabel: "Settings",
    onPress,
  };
}
