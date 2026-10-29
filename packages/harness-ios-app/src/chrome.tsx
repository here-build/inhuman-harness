import { PlatformColor, Pressable, StyleSheet, View, type ColorValue, type ViewStyle } from "react-native";

import { Symbol } from "./symbol.js";
import { Label } from "./type.js";

export const label = PlatformColor("label");
export const secondary = PlatformColor("secondaryLabel");
export const placeholder = PlatformColor("placeholderText");
export const background = PlatformColor("systemBackground");
export const grouped = PlatformColor("systemGroupedBackground");
export const card = PlatformColor("secondarySystemGroupedBackground");
export const separator = PlatformColor("separator");
export const orange = PlatformColor("systemOrange");
export const green = PlatformColor("systemGreen");
export const red = PlatformColor("systemRed");
export const blue = PlatformColor("systemBlue");
export const fill = PlatformColor("tertiarySystemFill");

/** The geometry of a UIKit inset-grouped table on iOS 26+, so JS-drawn groups sit beside native ones. */
export const RADIUS = 26;
/** Gap between the screen edge and a group card. */
export const INSET = 20;
/** Text starts this far into a card; separators start here too. */
export const EDGE = 20;

export function cardChrome(index: number, total: number, inset = true): ViewStyle {
  const first = index === 0;
  const last = index === total - 1;
  return {
    backgroundColor: card,
    marginHorizontal: inset ? INSET : 0,
    overflow: "hidden",
    borderCurve: "continuous",
    borderTopLeftRadius: first ? RADIUS : 0,
    borderTopRightRadius: first ? RADIUS : 0,
    borderBottomLeftRadius: last ? RADIUS : 0,
    borderBottomRightRadius: last ? RADIUS : 0,
  };
}

export const chrome = StyleSheet.create({
  screen: { flex: 1, backgroundColor: background },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: EDGE,
    paddingVertical: 14,
  },
  rowBody: { flex: 1, flexShrink: 1, minWidth: 0, gap: 2 },
  title: { color: label, fontSize: 17 },
  detail: { color: secondary, fontSize: 15 },
  trailing: { color: secondary, fontSize: 15, fontVariant: ["tabular-nums"] },
  section: {
    paddingHorizontal: 32,
    paddingTop: 18,
    paddingBottom: 6,
    color: secondary,
    fontSize: 13,
  },
  notice: { paddingHorizontal: 32, paddingTop: 12, paddingBottom: 4, color: secondary, fontSize: 15 },
  empty: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 32, gap: 6 },
  emptyTitle: { color: label, textAlign: "center" },
  emptyDetail: { color: secondary, textAlign: "center" },
  bar: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 8 },
  actions: { flexDirection: "row", gap: 12 },
  textButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  hairline: {
    position: "absolute",
    left: EDGE,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: separator,
  },
});

export function Hairline({ leading = EDGE }: { readonly leading?: number }) {
  return <View style={[chrome.hairline, { left: leading }]} />;
}

export function Notice({
  children,
  action,
}: {
  readonly children: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View>
      <Label accessibilityLiveRegion="polite" role="subhead" style={chrome.notice}>
        {children}
      </Label>
      {action == null ? null : <TextButton label={action.label} onPress={action.onPress} />}
    </View>
  );
}

/** A centered content-unavailable view: an optional SF Symbol, a headline, a subhead. */
export function Empty({
  title,
  detail,
  symbol,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly symbol?: string;
}) {
  return (
    <View style={chrome.empty}>
      {symbol == null ? null : (
        <View style={{ marginBottom: 8 }}>
          <Symbol name={symbol} size={48} color={PlatformColor("tertiaryLabel")} />
        </View>
      )}
      <Label role="headline" style={chrome.emptyTitle}>
        {title}
      </Label>
      {detail == null || detail === "" ? null : (
        <Label role="subhead" style={chrome.emptyDetail}>
          {detail}
        </Label>
      )}
    </View>
  );
}

export function TextButton({
  label: title,
  color: ink = blue,
  disabled = false,
  onPress,
  accessibilityLabel,
}: {
  readonly label: string;
  readonly color?: ColorValue;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        chrome.textButton,
        { alignSelf: "flex-start" },
        pressed && !disabled ? { opacity: 0.55 } : null,
      ]}
    >
      <Label color={disabled ? secondary : ink}>{title}</Label>
    </Pressable>
  );
}
