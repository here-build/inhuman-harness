import { type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { blue, cardChrome, chrome, EDGE, fill, Hairline, secondary } from "./chrome.js";
import { Symbol } from "./symbol.js";
import { Label } from "./type.js";

export function GroupedRow({
  title,
  detail,
  value,
  leading,
  index,
  total,
  selected = false,
  trailing = "none",
  disabled = false,
  inset = true,
  detailLines,
  detailColor,
  onPress,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly value?: string;
  readonly leading?: ReactNode;
  readonly index: number;
  readonly total: number;
  readonly selected?: boolean;
  readonly trailing?: "none" | "check" | "disclosure";
  readonly disabled?: boolean;
  readonly inset?: boolean;
  readonly detailLines?: number;
  readonly detailColor?: ColorValue;
  readonly onPress: () => void;
}) {
  const accessible = [title, detail, value].filter((part) => part != null && part !== "").join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessible}
      accessibilityState={{ disabled, ...(trailing === "check" ? { selected } : {}) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        chrome.row,
        cardChrome(index, total, inset),
        pressed && !disabled ? { backgroundColor: fill } : null,
      ]}
    >
      {leading}
      <View style={chrome.rowBody}>
        <Label>{title}</Label>
        {detail == null || detail === "" ? null : (
          <Label role="subhead" color={detailColor} numberOfLines={detailLines}>
            {detail}
          </Label>
        )}
      </View>
      {value == null || value === "" ? null : (
        <Label role="subhead" numberOfLines={1} style={{ flexShrink: 1 }}>
          {value}
        </Label>
      )}
      {trailing === "check" && selected ? <Symbol name="checkmark" color={blue} /> : null}
      {trailing === "disclosure" ? <Symbol name="chevron.right" size={13} color={secondary} /> : null}
      {index < total - 1 ? <Hairline leading={leading == null ? EDGE : EDGE + 30 + 12} /> : null}
    </Pressable>
  );
}
