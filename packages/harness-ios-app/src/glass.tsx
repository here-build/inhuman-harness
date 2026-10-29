import type { ReactNode } from "react";
import {
  StyleSheet,
  View,
  requireNativeComponent,
  type ColorValue,
  type HostComponent,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";

type NativeGlassProps = ViewProps & {
  cornerRadius: number;
  interactive?: boolean;
  tint?: ColorValue;
};

const NativeGlass: HostComponent<NativeGlassProps> = requireNativeComponent<NativeGlassProps>("HarnessGlass");

/** A Liquid Glass backdrop (system blur before iOS 26). Absolutely position it behind content. */
export function GlassBackground({
  style,
  radius = 0,
  tint,
  interactive = false,
}: {
  readonly style?: StyleProp<ViewStyle>;
  /** Corner radius in points, or "capsule" for fully rounded ends. */
  readonly radius?: number | "capsule";
  readonly tint?: ColorValue;
  readonly interactive?: boolean;
}) {
  return (
    <NativeGlass
      style={style}
      cornerRadius={radius === "capsule" ? -1 : radius}
      tint={tint}
      interactive={interactive}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

/** A view with a glass backdrop behind its children. */
export function Glass({
  style,
  radius,
  tint,
  interactive,
  children,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly radius?: number | "capsule";
  readonly tint?: ColorValue;
  readonly interactive?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <View style={style}>
      <GlassBackground style={StyleSheet.absoluteFill} radius={radius} tint={tint} interactive={interactive} />
      {children}
    </View>
  );
}
